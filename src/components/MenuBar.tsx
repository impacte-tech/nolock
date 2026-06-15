import { useState, useRef, useEffect } from "react";

interface MenuItem {
  label: string;
  action: () => void;
  shortcut?: string;
}

interface MenuGroup {
  label: string;
  items: MenuItem[];
}

interface Props {
  menus: MenuGroup[];
}

export default function MenuBar({ menus }: Props) {
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="menubar" ref={barRef}>
      {menus.map((menu, i) => (
        <div key={menu.label} className="menu-item-wrapper">
          <div
            className={`menu-label ${openMenu === i ? "open" : ""}`}
            onMouseDown={() => setOpenMenu(openMenu === i ? null : i)}
            onMouseEnter={() => openMenu !== null && setOpenMenu(i)}
          >
            {menu.label}
          </div>
          {openMenu === i && (
            <div className="menu-dropdown">
              {menu.items.map((item) => (
                <div
                  key={item.label}
                  className="menu-entry"
                  onClick={() => {
                    item.action();
                    setOpenMenu(null);
                  }}
                >
                  <span>{item.label}</span>
                  {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
