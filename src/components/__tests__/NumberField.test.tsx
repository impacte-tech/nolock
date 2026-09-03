// ---------------------------------------------------------------------------
// Tests for NumberField — the type-friendly number input used app-wide.
//
// Regression coverage for the "can't type numbers, only arrows work" bug:
// controlled number inputs that clamped/parsed every keystroke swallowed
// partial values ("1" while aiming for "128000") and snapped decimals.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import NumberField, { parseInt10 } from "../NumberField";

function getSpinbutton(): HTMLInputElement {
  return screen.getByRole("spinbutton") as HTMLInputElement;
}

describe("NumberField", () => {
  it("accepts a typed number and commits it live without clamping", () => {
    const onChange = vi.fn();
    render(<NumberField value={8192} onChange={onChange} min={64} parse={parseInt10} />);
    const input = getSpinbutton();

    // Typing a large number over the small default must simply work.
    fireEvent.change(input, { target: { value: "128000" } });
    expect(input.value).toBe("128000");
    expect(onChange).toHaveBeenLastCalledWith(128000);
  });

  it("does not clamp partial input while typing; applies min on blur", () => {
    const onChange = vi.fn();
    render(<NumberField value={4096} onChange={onChange} min={1024} parse={parseInt10} />);
    const input = getSpinbutton();

    // "5" is below min — it must still DISPLAY while typing (old behavior
    // snapped the field back to 1024, making typing impossible).
    fireEvent.change(input, { target: { value: "5" } });
    expect(input.value).toBe("5");
    expect(onChange).toHaveBeenLastCalledWith(5);

    fireEvent.blur(input);
    expect(input.value).toBe("1024");
    expect(onChange).toHaveBeenLastCalledWith(1024);
  });

  it("applies max on blur", () => {
    const onChange = vi.fn();
    render(
      <NumberField value={64} onChange={onChange} min={16} max={4096} parse={parseInt10} />,
    );
    const input = getSpinbutton();

    fireEvent.change(input, { target: { value: "99999" } });
    expect(onChange).toHaveBeenLastCalledWith(99999);
    fireEvent.blur(input);
    expect(input.value).toBe("4096");
    expect(onChange).toHaveBeenLastCalledWith(4096);
  });

  it("commits on Enter (no blur needed)", () => {
    const onChange = vi.fn();
    render(
      <NumberField value={64} onChange={onChange} min={16} max={4096} parse={parseInt10} />,
    );
    const input = getSpinbutton();

    fireEvent.change(input, { target: { value: "99999" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("4096");
    expect(onChange).toHaveBeenLastCalledWith(4096);
  });

  it("clearing the field commits the fallback value on blur", () => {
    const onChange = vi.fn();
    render(
      <NumberField value={10} onChange={onChange} min={1} emptyValue={10} parse={parseInt10} />,
    );
    const input = getSpinbutton();

    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(10);
    fireEvent.blur(input);
    expect(input.value).toBe("10");
  });

  it("clearing an optional field stays empty and commits undefined", () => {
    const onChange = vi.fn();
    render(<NumberField value={2} onChange={onChange} step="0.1" min="0" />);
    const input = getSpinbutton();

    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    fireEvent.blur(input);
    expect(input.value).toBe("");
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("keeps decimals as typed and normalizes on blur", () => {
    const onChange = vi.fn();
    render(<NumberField value={undefined} onChange={onChange} step="0.05" min="0" max="1" />);
    const input = getSpinbutton();

    fireEvent.change(input, { target: { value: "0.5" } });
    expect(input.value).toBe("0.5");
    expect(onChange).toHaveBeenLastCalledWith(0.5);
    fireEvent.blur(input);
    expect(input.value).toBe("0.5");
  });

  it("mirrors external value changes while not focused", () => {
    const onChange = vi.fn();
    const { rerender } = render(<NumberField value={1} onChange={onChange} />);
    const input = getSpinbutton();
    expect(input.value).toBe("1");

    rerender(<NumberField value={7} onChange={onChange} />);
    expect(input.value).toBe("7");
  });

  it("does not clobber in-progress edits when the parent value changes", () => {
    const onChange = vi.fn();
    const { rerender } = render(<NumberField value={1} onChange={onChange} />);
    const input = getSpinbutton();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "3" } });
    // Parent re-renders with some other value (e.g. live-commit echo) — the
    // field must keep showing what the user is typing.
    rerender(<NumberField value={999} onChange={onChange} />);
    expect(input.value).toBe("3");

    fireEvent.blur(input);
    expect(input.value).toBe("3");
  });

  it("renders an empty field for undefined values and a placeholder", () => {
    render(
      <NumberField value={undefined} onChange={() => {}} placeholder="256000 (default)" />,
    );
    const input = getSpinbutton();
    expect(input.value).toBe("");
    expect(input).toHaveAttribute("placeholder", "256000 (default)");
  });

  it("reverts when the value cannot be parsed", () => {
    const onChange = vi.fn();
    // Custom parse that always fails — simulates garbage the number input
    // can't represent (browsers sanitize unparseable .value to "" on real
    // number inputs, so the parse failure path is exercised directly here).
    render(<NumberField value={5} onChange={onChange} parse={() => NaN} />);
    const input = getSpinbutton();

    fireEvent.change(input, { target: { value: "7" } });
    // Live commit skips non-finite parses — nothing committed.
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input);
    // Blur reverts the display to the last committed value.
    expect(input.value).toBe("5");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("parseInt10 parses base-10 integers", () => {
    expect(parseInt10("42")).toBe(42);
    expect(parseInt10("08")).toBe(8); // no octal legacy parsing
    expect(Number.isNaN(parseInt10(""))).toBe(true);
  });
});
