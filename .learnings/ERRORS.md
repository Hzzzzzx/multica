# Errors

## [ERR-20260717-001] desktop-daemon-restart

**Logged**: 2026-07-17T08:57:00+08:00
**Priority**: high
**Status**: resolved
**Area**: infra

### Summary
Restarting the Multica Desktop launcher can reuse an already-running daemon, so newly bundled Go code may not actually be deployed.

### Error
```text
Kimi model discovery still completed with an empty model list after rebuilding the bundled CLI and restarting Desktop.
```

### Context
- Rebuilt `apps/desktop/resources/bin/multica` at 08:53.
- `desktop-ctl.sh restart` restarted Electron, but the daemon process had been running since 02:17.
- The Desktop manager intentionally reused that healthy daemon, so runtime requests still executed old code.

### Suggested Fix
After rebuilding the bundled CLI, compare the daemon process start time with the binary modification time. If the daemon predates the binary, stop the exact Desktop profile with `multica daemon stop --profile desktop-127.0.0.1-18480`, then restart Desktop and verify there is exactly one new daemon process.

### Metadata
- Reproducible: yes
- Related Files: apps/desktop/src/main/daemon-manager.ts, apps/desktop/resources/bin/multica
- Tags: desktop, daemon, deployment, stale-process

### Resolution
- **Resolved**: 2026-07-17T08:57:00+08:00
- **Notes**: Stopped the stale profile daemon, restarted Desktop, and verified live Kimi discovery returned three models with K3 as default.

---
