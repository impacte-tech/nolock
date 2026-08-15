import { useState, useRef, useEffect, type CSSProperties } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Shown when `value` is empty / doesn't match any option. */
  placeholder?: string;
  style?: CSSProperties;
}

/**
 * A custom dropdown selector.
 *
 * Replaces the native <select> element, whose popup is rendered by the OS/GTK
 * theme on Linux (WebKitGTK) and therefore ignores CSS `option` styling — which
 * produced white-on-white text in the dark theme. This component renders the
 * menu in ordinary DOM so it can be fully themed.
 */
export default function Select({ value, onChange, options, placeholder, style }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div className="field-select" ref={rootRef} style={style}>
      <button
        type="button"
        className="field-select-trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={selected ? "field-select-value" : "field-select-placeholder"}>
          {selected ? selected.label : placeholder || "Select…"}
        </span>
        <svg
          className={`field-select-chevron${open ? " open" : ""}`}
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="field-select-menu" role="listbox">
          {options.map((o) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`field-select-item${o.value === value ? " selected" : ""}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
