// ---------------------------------------------------------------------------
// Tests for DpoChoice component (pairwise preference selection)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DpoChoice } from "../ChatPanel";

describe("DpoChoice", () => {
  const responseA = "This is response A with some details.";
  const responseB = "This is response B with alternative details.";

  it("renders both response cards", () => {
    render(<DpoChoice responseA={responseA} responseB={responseB} onChoose={vi.fn()} />);

    expect(screen.getByText("Response A")).toBeInTheDocument();
    expect(screen.getByText("Response B")).toBeInTheDocument();
    expect(screen.getByText(responseA)).toBeInTheDocument();
    expect(screen.getByText(responseB)).toBeInTheDocument();
  });

  it("renders the header with instructions", () => {
    render(<DpoChoice responseA={responseA} responseB={responseB} onChoose={vi.fn()} />);

    expect(screen.getByText(/Which response is better/)).toBeInTheDocument();
    expect(screen.getByText(/you must choose one to continue/)).toBeInTheDocument();
  });

  it("renders two radio inputs", () => {
    render(<DpoChoice responseA={responseA} responseB={responseB} onChoose={vi.fn()} />);

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
  });

  it("has confirm button disabled when no selection is made", () => {
    render(<DpoChoice responseA={responseA} responseB={responseB} onChoose={vi.fn()} />);

    const confirmBtn = screen.getByText("Confirm Choice");
    expect(confirmBtn).toBeDisabled();
  });

  it("enables confirm button after selecting a response", () => {
    render(<DpoChoice responseA={responseA} responseB={responseB} onChoose={vi.fn()} />);

    const radioA = screen.getAllByRole("radio")[0];
    fireEvent.click(radioA);

    const confirmBtn = screen.getByText("Confirm Choice");
    expect(confirmBtn).not.toBeDisabled();
  });

  it("calls onChoose with 'A' when response A is selected and confirmed", () => {
    const onChoose = vi.fn();
    render(<DpoChoice responseA={responseA} responseB={responseB} onChoose={onChoose} />);

    const radioA = screen.getAllByRole("radio")[0];
    fireEvent.click(radioA);

    fireEvent.click(screen.getByText("Confirm Choice"));
    expect(onChoose).toHaveBeenCalledWith("A");
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("calls onChoose with 'B' when response B is selected and confirmed", () => {
    const onChoose = vi.fn();
    render(<DpoChoice responseA={responseA} responseB={responseB} onChoose={onChoose} />);

    const radioB = screen.getAllByRole("radio")[1];
    fireEvent.click(radioB);

    fireEvent.click(screen.getByText("Confirm Choice"));
    expect(onChoose).toHaveBeenCalledWith("B");
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("shows selected state on the chosen card", () => {
    render(<DpoChoice responseA={responseA} responseB={responseB} onChoose={vi.fn()} />);

    const radioB = screen.getAllByRole("radio")[1];
    fireEvent.click(radioB);

    // The parent div of the second card should have 'selected' class
    const cards = document.querySelectorAll(".dpo-choice-card");
    expect(cards[0].classList.contains("selected")).toBe(false);
    expect(cards[1].classList.contains("selected")).toBe(true);
  });

  it("does not call onChoose when confirm is clicked without selection", () => {
    const onChoose = vi.fn();
    render(<DpoChoice responseA={responseA} responseB={responseB} onChoose={onChoose} />);

    const confirmBtn = screen.getByText("Confirm Choice");
    expect(confirmBtn).toBeDisabled();
    fireEvent.click(confirmBtn); // no-op since disabled
    expect(onChoose).not.toHaveBeenCalled();
  });
});
