import { useCallback, useEffect, useRef, useState } from "react";

const MOBILE_DRAWER_QUERY = "(max-width: 880px)";
const INERT_TARGET_SELECTOR = "[data-mobile-drawer-inert]";
const FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function useMobileDrawer() {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined" && window.matchMedia(MOBILE_DRAWER_QUERY).matches,
  );
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);

  const open = useCallback(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(MOBILE_DRAWER_QUERY);
    const onChange = () => {
      setIsMobile(mq.matches);
      if (!mq.matches) setIsOpen(false);
    };
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!isMobile || !isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "Tab") {
        const drawer = document.querySelector<HTMLElement>(".sidebar[data-mobile-open='true']");
        if (!drawer) return;
        const focusables = Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
          (el) => el.offsetParent !== null,
        );
        if (focusables.length === 0) return;
        const first = focusables[0] as HTMLElement;
        const last = focusables[focusables.length - 1] as HTMLElement;
        const active = document.activeElement as HTMLElement;
        if (event.shiftKey) {
          if (active === first || !drawer.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !drawer.contains(active)) {
            event.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, isMobile, isOpen]);

  useEffect(() => {
    if (!isMobile || !isOpen) return;
    const previousOverflow = document.body.style.overflow;
    const inertTargets = Array.from(document.querySelectorAll<HTMLElement>(INERT_TARGET_SELECTOR));
    const previousInert = new Map<HTMLElement, boolean>();

    document.body.style.overflow = "hidden";
    for (const target of inertTargets) {
      previousInert.set(target, target.inert);
      target.inert = true;
    }

    // Move focus into drawer on next tick
    requestAnimationFrame(() => {
      const drawer = document.querySelector<HTMLElement>(".sidebar[data-mobile-open='true']");
      if (!drawer) return;
      const focusables = Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null,
      );
      (focusables[0] ?? drawer).focus();
    });

    return () => {
      document.body.style.overflow = previousOverflow;
      for (const target of inertTargets) {
        target.inert = previousInert.get(target) ?? false;
      }
      // Restore focus to trigger element
      triggerRef.current?.focus();
    };
  }, [isMobile, isOpen]);

  return { isMobile, isOpen, open, close };
}
