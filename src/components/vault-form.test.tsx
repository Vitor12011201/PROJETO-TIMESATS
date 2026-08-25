import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VaultForm } from "./vault-form";

const validPublicKey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

describe("VaultForm", () => {
  it("shows the test-network safety warnings and never offers mainnet", () => {
    render(<VaultForm />);
    expect(screen.getByText("SIGNET / REGTEST ONLY")).toBeVisible();
    expect(screen.getByText("DO NOT SEND REAL BITCOIN")).toBeVisible();
    expect(screen.queryByRole("option", { name: /mainnet/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Never enter a seed phrase or private key/i)).toBeVisible();
  });

  it("reports an understandable error for invalid form input and keeps result hidden", () => {
    render(<VaultForm />);
    fireEvent.change(screen.getByLabelText("Public key"), { target: { value: "not-a-public-key" } });
    fireEvent.change(screen.getByLabelText("Unlock block"), { target: { value: "840000" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar cofre" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Public key must be/);
    expect(screen.queryByText("COFRE DE TESTE")).not.toBeInTheDocument();
  });

  it("shows a result only after valid input", () => {
    render(<VaultForm />);
    fireEvent.change(screen.getByLabelText("Public key"), { target: { value: validPublicKey } });
    fireEvent.change(screen.getByLabelText("Unlock block"), { target: { value: "840000" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar cofre" }));
    expect(screen.getByText("COFRE DE TESTE")).toBeVisible();
    expect(screen.getByText(/^tb1q/)).toBeVisible();
  });
});
