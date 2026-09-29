/**
 * Lock survives episode auto-advance within a session. Advancing remounts the
 * player (key change) which would otherwise drop a pocket-lock mid-binge.
 *
 * Mount-counted handoff (no context, no extra renders): each mount cancels a
 * pending clear scheduled by the previous unmount, so an advance-remount
 * keeps the lock while a real unmount (navigate away / close) releases it on
 * the next macrotask. A fresh page load starts unlocked.
 */

let sessionLocked = false;
let lockMounts = 0;
let pendingLockClear: ReturnType<typeof setTimeout> | null = null;

export function readSessionLocked(): boolean {
  return sessionLocked;
}

export function writeSessionLocked(next: boolean): void {
  sessionLocked = next;
}

export function beginLockMount(): void {
  lockMounts += 1;
  if (pendingLockClear) {
    clearTimeout(pendingLockClear);
    pendingLockClear = null;
  }
}

export function endLockMount(): void {
  lockMounts = Math.max(0, lockMounts - 1);
  if (lockMounts === 0) {
    if (pendingLockClear) clearTimeout(pendingLockClear);
    pendingLockClear = setTimeout(() => {
      sessionLocked = false;
      pendingLockClear = null;
    }, 0);
  }
}
