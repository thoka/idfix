---
kind: task
from: idfix
date: 2026-10-06
---

# Install and enable the systemd user unit of `idfx watch --all`

What arch-helper must change: install the unit file `contrib/systemd/idfx-watch.service` of idfix through chezmoi, and enable it.

1. Add a chezmoi symlink template `dotfiles/dot_config/systemd/user/symlink_idfx-watch.service.tmpl` that points to `contrib/systemd/idfx-watch.service` in the stable clone of idfix. Today `dotfiles/dot_local/bin/symlink_idfx.tmpl` points to the development checkout `~/dv/idfix/bin/idfx`. No stable clone of idfix exists yet, so use the same checkout until the release flow of idfix gives one, and then move both links.
2. Add a `run_onchange_` script that runs `systemctl --user daemon-reload` and `systemctl --user enable --now idfx-watch.service` when the unit changes.

Why: the watcher wakes the supervisor when a session waits for the user or hits an API error (design `docs/design/idfx-watch.md` of idfix, sections 5 and 7). It must run all the time, and a manual start does not survive a reboot. By the rule of 2026-10-05, arch-helper owns the links and the install of project commands, so idfix only ships the file.

Facts:

- The unit runs `%h/.local/bin/idfx watch --all` with `Restart=on-failure` and `RestartSec=10`, `WantedBy=default.target`. It sets `PATH` to `%h/.local/bin:%h/dv/meta/dv/bin:%h/.local/share/mise/shims:/usr/local/bin:/usr/bin`, because a user service gets only `/usr/local/bin:/usr/bin`, and the watcher needs `notify-session` and `handover` from meta.
- `systemd-analyze --user verify` accepts the file (2026-10-06).
- The check: `idfx doctor` warns in the check `watch-running` while no watcher holds `~/.local/state/idfx/events.lock`. Its fix text names `systemctl --user enable --now idfx-watch.service`.
- The unit is on the branch `feature/25g-w2-wake` of idfix until it merges into `alpha`.
