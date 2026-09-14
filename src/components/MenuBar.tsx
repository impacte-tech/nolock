import { useState, useRef, useEffect, type ReactNode } from "react";

interface MenuItem {
  label: string;
  action: () => void;
  shortcut?: string;
  disabled?: boolean;
}

interface MenuGroup {
  label: string;
  items: MenuItem[];
}

interface Props {
  menus: MenuGroup[];
  /** Optional element rendered on the left side of the menu bar (e.g. logo). */
  logo?: ReactNode;
  mobileControls?: ReactNode;
}

export default function MenuBar({ menus, logo, mobileControls }: Props) {
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
        setExpanded(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className={`menubar${expanded ? " menubar-expanded" : ""}`} ref={barRef} onKeyDown={e => {
      if (e.key === "Escape") { setOpenMenu(null); setExpanded(false); }
    }}>
      {logo && <div className="menubar-logo">{logo}</div>}
      <div className="mobile-workspace-nav">
        {mobileControls}
        <button type="button" aria-label="Toggle menus" aria-expanded={expanded} onClick={() => { setExpanded(v => !v); setOpenMenu(null); }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
      </div>
      {menus.map((menu, i) => (
        <div key={menu.label} className="menu-item-wrapper">
          <button type="button"
            className={`menu-label ${openMenu === i ? "open" : ""}`}
            aria-expanded={openMenu === i}
            onClick={() => setOpenMenu(openMenu === i ? null : i)}
            // Hover-switch only where hover exists. When matchMedia is
            // unavailable (old jsdom/embedded webviews) assume desktop so the
            // classic hover behavior is preserved.
            onMouseEnter={() => (window.matchMedia?.("(hover: hover)")?.matches ?? true) && openMenu !== null && setOpenMenu(i)}
          >
            {menu.label}
          </button>
          {openMenu === i && (
            <div className="menu-dropdown">
              {menu.items.map((item) => (
                <button type="button"
                  key={item.label}
                  className={`menu-entry${item.disabled ? " menu-entry--disabled" : ""}`}
                  aria-disabled={item.disabled || undefined}
                  disabled={item.disabled}
                  onClick={() => {
                    if (item.disabled) return;
                    item.action();
                    setOpenMenu(null);
                    setExpanded(false);
                  }}
                >
                  <span>{item.label}</span>
                  {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
