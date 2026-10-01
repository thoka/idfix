# Permanent access to /dev/kvm under WSL2

Research date: 2026-10-01. Written for the sandbox step; background in [SANDBOX.md](SANDBOX.md).

Problem: on the host (Arch Linux under WSL2 with systemd), `/dev/kvm` needs read/write access for user `toka`. A manual `sudo chmod 0666 /dev/kvm` did not survive a WSL restart. On 2026-09-30 the device came back with mode 0660 and group ID 109, which has no name in `/etc/group`, and every Docker Sandbox start failed.

Note on this research run: the agent that wrote this report ran inside a sandbox (user `agent`, no systemd, no `/dev/kvm`, no `/etc/wsl.conf`), so it could not inspect the real WSL host directly. All facts below come from web sources; local values (the actual gid of `kvm` on the host, WSL version) must be confirmed on the host.

Facts carry a source (URL, plus the date the page was read: 2026-10-01). Statements marked **[guess]** are judgment.

## 0. Criteria

Each option is judged by:

1. Survives a WSL restart without manual steps.
2. Works with `systemd=true` on a current WSL2 release.
3. Least privilege: only the users who need KVM get it.
4. Matches how sbx actually gains access (device access by group of the process).
5. Small and robust: no race with device creation, no fragile timing.
6. Survives package updates without re-editing.

## 1. Who creates `/dev/kvm` in WSL2

- Without systemd, WSL2 has no udev. A maintainer states it plainly: "WSL2 does not use udev. We use devtmpfs." Static device nodes such as `/dev/kvm` then get their permissions from WSL's own `/init`, which sets them to `root:root` mode 0600. Users saw `crw------- 1 root root 10, 232` and had to fix it by hand on every boot ([https://github.com/microsoft/WSL/issues/4493](https://github.com/microsoft/WSL/issues/4493), read 2026-10-01; same report in [https://github.com/microsoft/WSL/issues/7149](https://github.com/microsoft/WSL/issues/7149), read 2026-10-01).
- With `systemd=true` in `/etc/wsl.conf`, systemd runs as PID 1 and starts `systemd-udevd`, which applies the udev rules. A user report on issue 7149 shows the change: without systemd `crw------- 1 root root`, with systemd `crw-rw---- 1 root kvm` ([https://github.com/microsoft/WSL/issues/7149](https://github.com/microsoft/WSL/issues/7149), read 2026-10-01).
- The rule that applies is the systemd default rule, template line 116 of `rules.d/50-udev-default.rules.in`:

  ```
  KERNEL=="kvm", GROUP="kvm", MODE="{{DEV_KVM_MODE}}", OPTIONS+="static_node=kvm"
  ```

  ([https://github.com/systemd/systemd/blob/main/rules.d/50-udev-default.rules.in](https://github.com/systemd/systemd/blob/main/rules.d/50-udev-default.rules.in), read 2026-10-01 via the GitHub API). The same line is present in tag v257.9 (checked 2026-10-01 via the GitHub API).
- The mode placeholder `DEV_KVM_MODE` defaults to `0666` upstream since systemd 236 (commit history in [https://bugs.launchpad.net/bugs/1884476](https://bugs.launchpad.net/bugs/1884476) discussion and the Debian bug [https://pkg-systemd-maintainers.alioth.debian.narkive.com/j7XO48KO/bug-887852-dev-kvm-is-no-longer-accessible-to-local-users](https://pkg-systemd-maintainers.alioth.debian.narkive.com/j7XO48KO/bug-887852-dev-kvm-is-no-longer-accessible-to-local-users), read 2026-10-01). On Arch today the rule resolves to `MODE="0666"` with group `kvm` ([https://bbs.archlinux.org/viewtopic.php?id=299045](https://bbs.archlinux.org/viewtopic.php?id=299045), read 2026-10-01). So on an Arch system where the `kvm` group exists, udev should produce `root:kvm 0666` — that is world-readable-writable despite the group, so the "0666" itself needs no extra work.
- So: whether `/dev/kvm` comes up with sane permissions **does depend on `systemd=true`**. Without systemd, WSL's `/init` makes it `root:root` 0600.
- Caveat: udev on WSL2 with systemd is still imperfect for hotplug events; some users must start or restart `systemd-udevd` manually ([https://github.com/microsoft/WSL/issues/8502](https://github.com/microsoft/WSL/issues/8502), read 2026-10-01). Static nodes like `kvm` are less affected than USB hotplug **[guess based on the static_node mechanism]**.
- Separate question: whether `/dev/kvm` exists at all. It needs `nestedVirtualization=true` in `%UserProfile%\.wslconfig` on the Windows side (not in `/etc/wsl.conf` — WSL warns `Unknown key 'wsl2.nestedVirtualization'` there), and the `kvm` plus `kvm_intel`/`kvm_amd` modules loaded. Since WSL 2.5.1 the modules live on a separate virtual drive and are not always auto-loaded; `sudo modprobe kvm kvm_intel` (or `kvm_amd`) may be needed ([https://github.com/microsoft/WSL/issues/13262](https://github.com/microsoft/WSL/issues/13262), read 2026-10-01). The host has the device, so this was already working there; this only matters if the device disappears.

## 2. Why group ID 109 appears

- The udev rule sets the group **by name** (`GROUP="kvm"`). If the name does not resolve, udev cannot apply it; since systemd 258, udev also refuses group names outside the system group range and logs for example `User 'dimich' is not a system user, ignoring` for the analogous OWNER case ([https://github.com/systemd/systemd/issues/39056](https://github.com/systemd/systemd/issues/39056), read 2026-10-01).
- A gid with no name on the device node means the group entry was deleted after the node was created, or the node was chgrp'd by number. The closest documented case is an Arch user whose `/dev/kvm` kept coming back as `root:108 (vboxusers)` although the rule said `GROUP="kvm"`: a package had once set that numeric gid, the group entry then changed, and the node kept the stale numeric gid across boots; the thread's suggested fix was to align the group id with the number the node gets, and the general fix was to audit what changes the node ([https://bbs.archlinux.org/viewtopic.php?id=299045](https://bbs.archlinux.org/viewtopic.php?id=299045), read 2026-10-01).
- On native Arch, `kvm` is a system group, normally gid 99 ([https://bbs.archlinux.org/viewtopic.php?id=299045](https://bbs.archlinux.org/viewtopic.php?id=299045) shows `kvm:x:992` on one machine — the gid varies per system). **[guess]** On the host, gid 109 is most likely a leftover `kvm` (or similar) group that a package created with gid 109 and that was later removed from `/etc/group`, while udev kept assigning the numeric gid 109 to the static node (the static node table `/usr/lib/tmpfiles.d/static-nodes-permissions.conf` and the devtmpfs node carry the numeric gid, not the name). How to confirm on the host: check `journalctl -u systemd-udevd -b` for a message like `Failed to resolve group 'kvm'`, and check `/etc/group-` (the backup file) for a group that once had gid 109 ([https://anadoxin.org/blog/wrong-kvm-permissions/](https://anadoxin.org/blog/wrong-kvm-permissions/), read 2026-10-01, describes the "Failed to resolve group" symptom).
- Mapping it: create (or renumber) the group with that id, so name and number match and udev can resolve it:

  ```
  sudo groupadd -g 109 kvm     # if no kvm group exists
  # or: sudo groupmod -g 109 kvm   (then fix file ownerships that referenced the old gid)
  ```

  Gid 109 is inside the system group range (SYS_GID_MAX is typically 999), so udev accepts it (system group range rule: [https://github.com/systemd/systemd/issues/39056](https://github.com/systemd/systemd/issues/39056) and [https://anadoxin.org/blog/wrong-kvm-permissions/](https://anadoxin.org/blog/wrong-kvm-permissions/), read 2026-10-01).

## 3. The options, compared

| Option | Survives restart | Works with systemd=true | Least privilege | How sbx gets access | Robustness | Effort |
|---|---|---|---|---|---|---|
| A. udev default rule + `kvm` group + user in group | Yes | Yes | Good (0660 with a group rule; 0666 on Arch's shipped rule) | Process runs as group `kvm`, or Docker `--group-add 109` | Best: this is the mechanism distros intend; no timing | Small |
| B. `[boot] command=` in `/etc/wsl.conf` | Yes | Yes, and also without systemd | Depends on what the command sets | Same as A, by group | Timing race: `/dev/kvm` may not exist yet when the command runs; needs a wait loop | Small |
| C. systemd unit or `tmpfiles.d` | Yes | Yes | Good | Same as A | Good; `tmpfiles.d` has no order guarantee vs udev **[guess]** | Small |
| D. `nestedVirtualization` / `kernelCommandLine` in `.wslconfig` | Yes | Yes | None — does not touch permissions | No | Wrong tool: only makes the device exist; `kernelCommandLine` sets kernel parameters, not node permissions | n/a |
| E. `chmod 0666` in a boot command or `.bashrc` | Yes (boot command) | Yes | Bad: every local user and every container user can use KVM | Always | Works but is the wide-open setting | Smallest |

Details and sources for each:

### A. udev rule + kvm group

The systemd default rule already exists on the host (`/usr/lib/udev/rules.d/50-udev-default.rules`, `KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"` on Arch; [https://bbs.archlinux.org/viewtopic.php?id=299045](https://bbs.archlinux.org/viewtopic.php?id=299045), read 2026-10-01). It fails only when the `kvm` group does not resolve. With a `kvm` group that exists and `toka` in it, the node comes up correctly after every restart. Multiple WSL reports confirm this path works once systemd is on ([https://github.com/microsoft/WSL/issues/7149](https://github.com/microsoft/WSL/issues/7149), read 2026-10-01; [https://iii.dev/docs/troubleshooting](https://iii.dev/docs/troubleshooting), read 2026-10-01).

If the wide 0666 of the Arch default rule is not wanted, override it with a higher-priority custom rule in `/etc/udev/rules.d/70-kvm.rules`:

```
KERNEL=="kvm", GROUP="kvm", MODE="0660", OPTIONS+="static_node=kvm"
```

(The 0660 form is what Ubuntu and older Debian ship; [https://github.com/microsoft/WSL/issues/7149](https://github.com/microsoft/WSL/issues/7149) and [https://bugs.launchpad.net/bugs/2004271](https://bugs.launchpad.net/bugs/2004271), read 2026-10-01.)

Failure mode of A: if the group is missing or non-system, udev falls back — the node stays `root:root` or keeps a stale numeric gid, which is exactly the observed 2026-09-30 failure ([https://anadoxin.org/blog/wrong-kvm-permissions/](https://anadoxin.org/blog/wrong-kvm-permissions/), read 2026-10-01).

For Docker: a container process needs the numeric gid; `--group-add kvm` resolves in the container's `/etc/group`, not the host's, and fails there ([https://github.com/docker/cli/issues/4714](https://github.com/docker/cli/issues/4714), read 2026-10-01). Use `--group-add 109` (the numeric gid) for sbx/Docker. Whether sbx exposes a flag to add host groups to its microVM is not documented — open question.

### B. `[boot] command=` in /etc/wsl.conf

Microsoft's own maintainer suggested it on issue 7149:

```
# /etc/wsl.conf
[boot]
systemd=true
command = /bin/bash -c 'chown root:kvm /dev/kvm && chmod 660 /dev/kvm'
```

([https://github.com/microsoft/WSL/issues/7149](https://github.com/microsoft/WSL/issues/7149), read 2026-10-01.) It runs as root at distro start, also without systemd. The known problem is ordering: the command can run before the kernel module is loaded and `/dev/kvm` exists, so the robust version waits for the node ([https://serverfault.com/questions/1043441/how-to-run-kvm-nested-in-wsl2-or-vmware/1043458](https://serverfault.com/questions/1043441/how-to-run-kvm-nested-in-wsl2-or-vmware/1043458), read 2026-10-01):

```
[boot]
command = "modprobe kvm_intel && while [ ! -e /dev/kvm ]; do sleep 0.1; done && chown root:kvm /dev/kvm && chmod 660 /dev/kvm"
```

A report from Debian 12 also shows a `wsl.conf` boot command can confuse the udev package's post-install script (addgroup errors), an annoyance, not a blocker ([https://gist.github.com/CorruptBandit/3f8e2cd8fb4407d212ec45afcf651983](https://gist.github.com/CorruptBandit/3f8e2cd8fb4407d212ec45afcf651983), read 2026-10-01).

### C. systemd unit or tmpfiles.d

systemd itself ships `/usr/lib/tmpfiles.d/static-nodes-permissions.conf` with `z /dev/kvm 0666 - kvm -` on Arch ([https://bbs.archlinux.org/viewtopic.php?id=299045](https://bbs.archlinux.org/viewtopic.php?id=299045), read 2026-10-01), so a local drop-in `/etc/tmpfiles.d/kvm.conf` with

```
z /dev/kvm 0660 - kvm -
```

matches an established mechanism. A custom systemd unit that chowns/chmods `WantedBy=multi-user.target` works the same way. Both need systemd enabled, which the host has. No WSL-specific failure report was found for these **[no contrary source found; not proven on WSL]**.

### D. .wslconfig settings

`nestedVirtualization=true` in `%UserProfile%\.wslconfig` only makes the device exist (and it is reportedly on by default now); it does nothing about owner, group, or mode. Putting it in `/etc/wsl.conf` is invalid ([https://github.com/microsoft/WSL/issues/13262](https://github.com/microsoft/WSL/issues/13262), read 2026-10-01; [https://serverfault.com/questions/1043441/...1043458](https://serverfault.com/questions/1043441/how-to-run-kvm-nested-in-wsl2-or-vmware/1043458), read 2026-10-01). `kernelCommandLine` passes kernel parameters; it does not set device node permissions. **Not a fix for this problem.**

### E. Mode 0666

`chmod 0666 /dev/kvm` (whether manual or in a boot command) gives every local user — and every process in every container that can reach the device — full KVM access. KVM access is effectively root-equivalent on the machine: a KVM guest can be given arbitrary host memory of the VMs it creates, and any local user could run their own VMs. The KVM project's FAQ recommends group access, not world access ([https://www.linux-kvm.org/page/FAQ#How_can_I_use_KVM_with_a_non-privileged_user.3F](https://www.linux-kvm.org/page/FAQ), referenced from [https://unix.stackexchange.com/questions/526377/no-kvm-related-group-but-module-exists](https://unix.stackexchange.com/questions/526377/no-kvm-related-group-but-module-exists), read 2026-10-01). One WSL blogger even argues "WSL is not for security" and uses 777 ([https://akc3n.page/posts/grapheneos-wsl/](https://akc3n.page/posts/grapheneos-wsl/), read 2026-10-01) — that view does not fit this project, which sandboxes agents on purpose.

## 4. Comparison verdict

Option A is the only one that fixes the root cause (a group name that does not resolve) with the mechanism the distribution already ships, and it composes with a mode override to reach least privilege. Option B is the standard fallback when udev does not run, but on this host systemd runs, so B only duplicates what A does, with a timing race. Option C is an acceptable variant of A. Option D is orthogonal. Option E is the current insecure state.

Deciding criteria: (2) works with systemd — favors A; (3) least privilege — favors a group rule with 0660 over the shipped 0666; (1)+(5) survive restarts without races — favors A over B; (6) survives updates — favors using the distro's own group and rule files.

**Recommendation: Option A, with a mode override to 0660.** Create the `kvm` group with gid 109 (so the observed numeric gid and the name agree), put `toka` in it, add a `/etc/udev/rules.d/` rule with `MODE="0660"`, and pass the numeric gid to Docker/sbx where needed. Keep `nestedVirtualization=true` in `.wslconfig` only as the prerequisite it already is.

## 5. Exact steps of each working option

### Option A (recommended): group + udev rule

On the host, as root:

1. Create or fix the group so that name and the observed numeric gid match:

   ```
   getent group kvm || sudo groupadd -g 109 kvm
   sudo groupmod -g 109 kvm   # only if kvm exists with another gid and nothing else owns files with the old gid
   ```

2. Add the user:

   ```
   sudo usermod -aG kvm toka
   ```

   (`toka` must log in again, or restart WSL, for the group to apply.)

3. Optional mode tightening to 0660 (the Arch default rule is 0666): create `/etc/udev/rules.d/70-kvm.rules` with

   ```
   KERNEL=="kvm", GROUP="kvm", MODE="0660", OPTIONS+="static_node=kvm"
   ```

4. Restart WSL (`wsl.exe --shutdown` from Windows), then verify on the host:

   ```
   ls -l /dev/kvm          # expect crw-rw---- root kvm (or root 109 with a name after step 1)
   id toka                 # expect kvm in the group list
   ```

5. For Docker/Sandbox use of the device, pass the numeric group: `--group-add $(stat -c %g /dev/kvm)`. Name-based `--group-add kvm` looks up the container's `/etc/group` and fails ([https://github.com/docker/cli/issues/4714](https://github.com/docker/cli/issues/4714), read 2026-10-01).

### Option B: boot command in /etc/wsl.conf

Works also without udev, but is redundant on this host:

```
# /etc/wsl.conf
[boot]
systemd=true
command = "modprobe kvm_intel && while [ ! -e /dev/kvm ]; do sleep 0.1; done && chown root:kvm /dev/kvm && chmod 660 /dev/kvm"
```

Add `toka` to the `kvm` group as in Option A step 2 (the group entry must still exist for the chown to resolve the name; otherwise use the numeric gid: `chown root:109 /dev/kvm`). Then `wsl.exe --shutdown`.

### Option C: tmpfiles.d

```
# /etc/tmpfiles.d/kvm.conf
z /dev/kvm 0660 - kvm -
```

Plus the group and user from Option A steps 1–2 and a WSL restart. systemd-tmpfiles applies it at boot; whether it runs before or after udev touches the node on WSL2 is unverified **[guess]**.

## 6. Open questions

- What created the group with gid 109 on the host and why it disappeared from `/etc/group` — needs a look at `/etc/group-`, `journalctl -u systemd-udevd -b`, and the package history on the host; this run could not inspect the host.
- Whether sbx/Docker Sandboxes offers a documented way to add a host group (numeric gid) to its microVM, so the sandboxed VM can open `/dev/kvm`.
- Whether `systemd-tmpfiles` (Option C) runs reliably relative to udev on WSL2 — unverified.
- Current WSL version on the host, and whether the `kvm` kernel modules auto-load there after a restart (WSL ≥ 2.5.1 regression; [https://github.com/microsoft/WSL/issues/13262](https://github.com/microsoft/WSL/issues/13262), read 2026-10-01).

## 7. Host check by the main thread (2026-10-01)

The main thread checked the host after this report, with read-only commands. The facts contradict the guess of section 2:

- The group `kvm` exists with gid 990, in `/etc/group` and in `/etc/group-`. No group has gid 109.
- `/usr/lib/udev/rules.d/50-udev-default.rules` line 116 and `/usr/lib/tmpfiles.d/static-nodes-permissions.conf` line 18 set `root:kvm` with mode 0666. So udev and tmpfiles of this distro give `toka` access by themselves.
- `/etc/wsl.conf` sets `systemd=true` and no boot command.
- Today `/dev/kvm` is `root:root` with mode 0666 (the manual fix).
- `toka` is not in the group `kvm`.

So the state of 2026-09-30 (gid 109, mode 0660) did not come from udev of this distro. All WSL2 distros share one kernel and one devtmpfs **[guess, not verified]**. A second distro, for example `docker-desktop` or an Ubuntu distro with its own `kvm` group of gid 109, can change the shared node after this distro starts. Option A with gid 109 would then fight the other distro instead of fixing the cause.

Next check, by the user on Windows: `wsl.exe -l -v` lists the distros that run. If another distro runs, look at its `getent group 109` and its udev rules. The fix then belongs either to that distro (the same mode 0666 or a group rule), or to a systemd path unit in this distro that re-applies `chgrp kvm /dev/kvm` and `chmod 0660 /dev/kvm` when the node changes, together with `usermod -aG kvm toka`.
