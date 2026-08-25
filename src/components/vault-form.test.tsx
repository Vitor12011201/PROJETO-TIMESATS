import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { validTestTpub } from "@/tests/fixtures";
import { VAULT_PLAN_STORAGE_KEY } from "@/storage/vault-plan-storage";
import { VaultForm } from "./vault-form";

afterEach(() => window.localStorage.removeItem(VAULT_PLAN_STORAGE_KEY));

function fillValidPlan(): void {
  fireEvent.change(screen.getByLabelText("Nome do plano"), { target: { value: "Minha Casa" } });
  fireEvent.change(screen.getByLabelText(/Extended public key/), { target: { value: validTestTpub } });
  fireEvent.change(screen.getByLabelText("Unlock block"), { target: { value: "840000" } });
}

describe("VaultForm", () => {
  it("shows test-network warnings, public-only warnings, and never offers mainnet", () => {
    render(<VaultForm />);
    expect(screen.getByText("SIGNET / REGTEST ONLY")).toBeVisible();
    expect(screen.getByText("DO NOT SEND REAL BITCOIN")).toBeVisible();
    expect(screen.queryByRole("option", { name: /mainnet/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Never enter a seed phrase or private key/i)).toBeVisible();
    expect(screen.getByText(/pode revelar relações entre endereços derivados/i)).toBeVisible();
  });

  it("rejects private input with an understandable error and keeps a result hidden", () => {
    render(<VaultForm />);
    fireEvent.change(screen.getByLabelText("Nome do plano"), { target: { value: "Minha Casa" } });
    fireEvent.change(screen.getByLabelText(/Extended public key/), { target: { value: "tprv8ZgxMBicQKsPe" } });
    fireEvent.change(screen.getByLabelText("Unlock block"), { target: { value: "840000" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar plano" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/must not receive an extended private key/i);
    expect(screen.queryByText("VAULT PLAN · TEST NETWORK")).not.toBeInTheDocument();
  });

  it("creates a plan with Deposit #0 and generates Deposit #1 without showing a balance", () => {
    render(<VaultForm />);
    fillValidPlan();
    fireEvent.click(screen.getByRole("button", { name: "Criar plano" }));
    expect(screen.getByText("VAULT PLAN · TEST NETWORK")).toBeVisible();
    expect(screen.getByText("Deposit #0")).toBeVisible();
    expect(screen.getByText("Deposits issued").nextElementSibling).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: /Adicionar sats/ }));
    expect(screen.getByText("Deposit #1")).toBeVisible();
    expect(screen.getByText("Deposits issued").nextElementSibling).toHaveTextContent("2");
    expect(screen.queryByText(/total.*sats|bitcoin balance|saldo confirmado/i)).not.toBeInTheDocument();
  });
});
