"use client";

import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getApi } from "../api";
import { useAuthStore } from "../auth";
import {
  captureSignupSource,
  identify as identifyAnalytics,
  initAnalytics,
  resetAnalytics,
} from "../analytics";
import { configStore } from "../config";
import { workspaceKeys } from "../workspace/queries";
import { createLogger } from "../logger";
import { defaultStorage } from "./storage";
import { setCurrentWorkspace } from "./workspace-storage";
import type { ClientIdentity } from "./types";
import type { StorageAdapter } from "../types/storage";
import type { User } from "../types";

const logger = createLogger("auth");

export function AuthInitializer({
  children,
  onLogin,
  onLogout,
  storage = defaultStorage,
  cookieAuth,
  identity,
}: {
  children: ReactNode;
  onLogin?: () => void;
  onLogout?: () => void;
  storage?: StorageAdapter;
  cookieAuth?: boolean;
  identity?: ClientIdentity;
}) {
  const qc = useQueryClient();

  useEffect(() => {
    const api = getApi();

    // Stamp attribution before anything else — the signup event (server-side)
    // reads this cookie, so it has to be present before the user hits submit.
    captureSignupSource();

    const isTianYuanWebView =
      typeof navigator !== "undefined" &&
      /TianYuanAndroidMultica/.test(navigator.userAgent);

    const seed = (
      user: User,
      wsList: Awaited<ReturnType<typeof api.listWorkspaces>>,
      token?: string,
    ) => {
      if (token) {
        api.setToken(token);
        storage.setItem("multica_token", token);
      }
      try {
        onLogin?.();
      } catch {
        /* ignore */
      }
      useAuthStore.setState({ user, isLoading: false });
      try {
        identifyAnalytics(user.id, { email: user.email, name: user.name });
      } catch {
        /* ignore */
      }
      qc.setQueryData(workspaceKeys.list(), wsList);
      // 固定本地主 workspace，避免 !workspace 卡 MulticaIcon
      const preferred =
        wsList.find((w) => w.slug === "workspace") ?? wsList[0] ?? null;
      if (preferred) {
        setCurrentWorkspace(preferred.slug, preferred.id);
      }
      console.log(
        "[ty-auth] store seeded " +
          String(user?.email) +
          " n=" +
          String(wsList?.length) +
          " ws=" +
          String(preferred?.slug),
      );
    };

    // 供 Android WebView 在 fetch 完 token 后直接灌会话（不依赖 useEffect 时序）
    if (typeof window !== "undefined") {
      (
        window as unknown as {
          __tianyuanSeedSession?: (p: {
            token: string;
            user: User;
            workspaces: Awaited<ReturnType<typeof api.listWorkspaces>>;
          }) => void;
        }
      ).__tianyuanSeedSession = (p) => {
        seed(p.user, p.workspaces, p.token);
      };
    }

    // TianYuan 嵌入：强制 dev@multica.local 会话，只维护 Multica 网页看板
    if (isTianYuanWebView) {
      useAuthStore.setState({ isLoading: true });
      console.log("[ty-auth] webview dev auto-login start");
      const existing = storage.getItem("multica_token");
      const boot = existing
        ? Promise.resolve(existing).then((token) => {
            api.setToken(token);
            return Promise.all([api.getMe(), api.listWorkspaces()]).then(
              ([user, wsList]) => ({ user, wsList, token }),
            );
          })
        : api.devLogin().then((res) => {
            api.setToken(res.token);
            storage.setItem("multica_token", res.token);
            return Promise.all([api.getMe(), api.listWorkspaces()]).then(
              ([user, wsList]) => ({ user, wsList, token: res.token }),
            );
          });
      boot
        .then(({ user, wsList, token }) => seed(user, wsList, token))
        .catch((err) => {
          console.log("[ty-auth] failed, try devLogin again " + String(err));
          api
            .devLogin()
            .then((res) => {
              api.setToken(res.token);
              storage.setItem("multica_token", res.token);
              return Promise.all([api.getMe(), api.listWorkspaces()]).then(
                ([user, wsList]) => ({ user, wsList, token: res.token }),
              );
            })
            .then(({ user, wsList, token }) => seed(user, wsList, token))
            .catch((err2) => {
              logger.error("tianyuan webview dev auto-login failed", err2);
              try {
                onLogout?.();
              } catch {
                /* ignore */
              }
              resetAnalytics();
              useAuthStore.setState({ user: null, isLoading: false });
            });
        });
      api.getConfig().catch(() => {});
      return;
    }

    // Fetch app config (CDN domain, PostHog key, …) in the background — non-blocking.
    api
      .getConfig()
      .then((cfg) => {
        if (cfg.cdn_domain) {
          configStore.getState().setCdnConfig({
            cdnDomain: cfg.cdn_domain,
            // Old servers omit this — false keeps the previous behavior.
            cdnSigned: cfg.cdn_signed === true,
          });
        }
        configStore.getState().setAuthConfig({
          allowSignup: cfg.allow_signup,
          googleClientId: cfg.google_client_id,
          // Old servers omit this field — treat that as "creation allowed"
          // (the managed-cloud default) rather than blocking the UI.
          workspaceCreationDisabled: cfg.workspace_creation_disabled === true,
        });
        configStore.getState().setDaemonConfig({
          daemonServerUrl: cfg.daemon_server_url,
          daemonAppUrl: cfg.daemon_app_url,
        });
        configStore.getState().setFeatureFlags(cfg.feature_flags);
        configStore.getState().setServerVersion(cfg.server_version);
        if (cfg.posthog_key) {
          initAnalytics({
            key: cfg.posthog_key,
            host: cfg.posthog_host || "",
            appVersion: identity?.version,
            environment: cfg.analytics_environment,
          });
        }
      })
      .catch(() => {
        /* config is optional — legacy file card matching degrades gracefully */
      });

    const onAuthSuccess = (user: User) => {
      onLogin?.();
      useAuthStore.setState({ user, isLoading: false });
      identifyAnalytics(user.id, { email: user.email, name: user.name });
    };

    const onAuthFailure = () => {
      onLogout?.();
      resetAnalytics();
      useAuthStore.setState({ user: null, isLoading: false });
    };

    if (cookieAuth) {
      // Cookie mode: the HttpOnly cookie is sent automatically by the browser.
      // Call the API to check if the session is still valid.
      //
      // Seed the workspace list into React Query so the URL-driven layout can
      // resolve the slug without a second fetch. The active workspace itself
      // is derived from the URL by [workspaceSlug]/layout.tsx — no imperative
      // selection here.
      //
      // Local/dev + Android WebView: cookie often missing on first open.
      // Fall back to /auth/dev-login (JSON) so embedded boards auto-enter as
      // dev@multica.local without a login form.
      const seedSession = (user: User, wsList: Awaited<ReturnType<typeof api.listWorkspaces>>) => {
        onAuthSuccess(user);
        qc.setQueryData(workspaceKeys.list(), wsList);
      };
      Promise.all([api.getMe(), api.listWorkspaces()])
        .then(([user, wsList]) => {
          seedSession(user, wsList);
        })
        .catch((err) => {
          logger.error("cookie auth init failed", err);
          if (process.env.NODE_ENV === "development") {
            api
              .devLogin()
              .then((res) => {
                api.setToken(res.token);
                storage.setItem("multica_token", res.token);
                return Promise.all([api.getMe(), api.listWorkspaces()]);
              })
              .then(([user, wsList]) => {
                seedSession(user, wsList);
              })
              .catch((devErr) => {
                logger.error("dev auto-login after cookie failure failed", devErr);
                onAuthFailure();
              });
            return;
          }
          onAuthFailure();
        });
      return;
    }

    // Token mode: read from localStorage (Electron / legacy).
    const token = storage.getItem("multica_token");
    if (!token) {
      if (process.env.NODE_ENV === "development") {
        api
          .devLogin()
          .then((res) => {
            api.setToken(res.token);
            storage.setItem("multica_token", res.token);
            return Promise.all([api.getMe(), api.listWorkspaces()]);
          })
          .then(([user, wsList]) => {
            onAuthSuccess(user);
            qc.setQueryData(workspaceKeys.list(), wsList);
          })
          .catch((err) => {
            logger.error("dev auto-login failed", err);
            onAuthFailure();
          });
        return;
      }
      onLogout?.();
      useAuthStore.setState({ isLoading: false });
      return;
    }

    api.setToken(token);

    Promise.all([api.getMe(), api.listWorkspaces()])
      .then(([user, wsList]) => {
        onAuthSuccess(user);
        // Seed React Query cache so the URL-driven layout can resolve the
        // slug without a second fetch.
        qc.setQueryData(workspaceKeys.list(), wsList);
      })
      .catch((err) => {
        logger.error("auth init failed", err);
        api.setToken(null);
        setCurrentWorkspace(null, null);
        storage.removeItem("multica_token");
        onAuthFailure();
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <>{children}</>;
}
