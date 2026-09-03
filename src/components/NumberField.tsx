import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

// ---------------------------------------------------------------------------
// NumberField — a `type="number"` input the user can actually TYPE into.
//
// The naive pattern used across the app before this component
//
//   <input type="number" value={n}
//          onChange={(e) => setN(Math.max(min, parseInt(e.target.value) || fallback))} />
//
// is hostile to typing: every keystroke is parsed, clamped and written back
// into the controlled value, so partial numbers get swallowed — typing "1"
// while aiming for "128000" snaps back to the clamp, deleting the field snaps
// to the fallback, and typing decimals ("0." on the way to "0.5") loses the
// dot. That leaves the spinner arrows as the only usable control.
//
// This component keeps the raw text in local state while the field is focused
// (any intermediate value displays exactly as typed), commits the parsed
// number to `onChange` while typing so dependent state stays live, and
// normalizes — fallback for empty, min/max clamp — when the field is left
// (blur or Enter). The spinner arrows keep working because they fire
// `onChange` with a complete value, which is committed like any other input.
// ---------------------------------------------------------------------------

/** Parse as an integer — for whole-number fields (tokens, retries, intervals). */
export function parseInt10(text: string): number {
  return parseInt(text, 10);
}

export interface NumberFieldProps {
  /** Committed value; `undefined`/`null`/"" renders an empty field. */
  value: number | string | null | undefined;
  /** Called with the parsed number while typing; empty field → `emptyValue`. */
  onChange: (value: number | undefined) => void;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  placeholder?: string;
  title?: string;
  disabled?: boolean;
  style?: CSSProperties;
  className?: string;
  id?: string;
  /** Text → number (default parseFloat). Use `parseInt10` for integer fields. */
  parse?: (text: string) => number;
  /** Value committed when the field is left empty (default: undefined). */
  emptyValue?: number;
  /** Extra normalization applied on commit (min/max props are always applied). */
  clamp?: (n: number) => number;
}

export default function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  title,
  disabled,
  style,
  className,
  id,
  parse = parseFloat,
  emptyValue,
  clamp,
}: NumberFieldProps) {
  const [text, setText] = useState(() =>
    value == null || value === "" ? "" : String(value),
  );
  const focusedRef = useRef(false);

  // Mirror external value changes into the field, but never while the user is
  // editing — their in-progress text is the source of truth while focused.
  useEffect(() => {
    if (!focusedRef.current) {
      setText(value == null || value === "" ? "" : String(value));
    }
  }, [value]);

  const commit = (raw: string) => {
    const t = raw.trim();
    if (t === "") {
      // Empty field: commit the fallback, or clear the field entirely for
      // optional values (emptyValue undefined).
      setText(emptyValue != null ? String(emptyValue) : "");
      onChange(emptyValue);
      return;
    }
    let n = parse(t);
    if (!Number.isFinite(n)) {
      // Not a number — revert the display to the committed value.
      setText(value == null || value === "" ? "" : String(value));
      return;
    }
    if (clamp) n = clamp(n);
    if (min != null && n < Number(min)) n = Number(min);
    if (max != null && n > Number(max)) n = Number(max);
    setText(String(n));
    onChange(n);
  };

  return (
    <input
      id={id}
      type="number"
      className={className ?? "field-input"}
      style={style}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      title={title}
      disabled={disabled}
      value={text}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        // Commit every parseable intermediate while typing ("" → emptyValue).
        // The input keeps displaying the raw text, so "1" → "12" → "128000"
        // and "0." → "0.5" all survive on the way to the final number.
        const trimmed = t.trim();
        if (trimmed === "") {
          onChange(emptyValue);
          return;
        }
        const n = parse(trimmed);
        if (Number.isFinite(n)) onChange(n);
      }}
      onBlur={(e) => {
        focusedRef.current = false;
        commit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          // Commit explicitly (don't rely on the blur event firing)…
          commit(e.currentTarget.value);
          // …then leave the field so the change is visually "sealed".
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
