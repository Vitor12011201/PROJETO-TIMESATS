import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { validTestTpub } from "@/tests/fixtures";
import { VAULT_PLAN_STORAGE_KEY } from "@/storage/vault-plan-storage";
import { VaultForm } from "./vault-form";

afterEach(() => window.localStorage.removeItem(VAULT_PLAN_STORAGE_KEY));

function openCreateDialog(): void {
  fireEvent.click(screen.getAllByRole("button", { name: "Criar meu plano" })[0]);
}

function fillValidPlan(): void {
  fireEvent.change(screen.getByLabelText("Nome do plano"), { target: { value: "Minha Casa" } });
  fireEvent.change(screen.getByLabelText(/Chave pública estendida/), { target: { value: validTestTpub } });
  fireEvent.change(screen.getByLabelText(/Fingerprint mestre público/), { target: { value: "deadbeef" } });
  fireEvent.change(screen.getByLabelText(/Caminho absoluto da tpub/), { target: { value: "m" } });
  fireEvent.change(screen.getByLabelText("Bloco de desbloqueio"), { target: { value: "840000" } });
}

describe("VaultForm", () => {
  it("shows test-network warnings, never offers mainnet, and keeps semantic navigation", () => {
    render(<VaultForm />);
    expect(screen.getByText(/Experimental software\. Signet \/ Regtest only/i)).toBeVisible();
    expect(screen.getByText(/Do not send real bitcoin/i)).toBeVisible();
    expect(screen.queryByRole("option", { name: /mainnet/i })).not.toBeInTheDocument();
    openCreateDialog();
    expect(screen.getByRole("dialog", { name: /Crie seu compromisso/i })).toBeVisible();
    expect(screen.getByText(/Nunca informe seed ou chave privada/i)).toBeVisible();
  });

  it("rejects private input with an understandable error and keeps the plan panel absent", () => {
    render(<VaultForm />);
    openCreateDialog();
    fireEvent.change(screen.getByLabelText("Nome do plano"), { target: { value: "Minha Casa" } });
    fireEvent.change(screen.getByLabelText(/Chave pública estendida/), { target: { value: "tprv8ZgxMBicQKsPe" } });
    fireEvent.change(screen.getByLabelText(/Fingerprint mestre público/), { target: { value: "deadbeef" } });
    fireEvent.change(screen.getByLabelText(/Caminho absoluto da tpub/), { target: { value: "m" } });
    fireEvent.change(screen.getByLabelText("Bloco de desbloqueio"), { target: { value: "840000" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar plano" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/must not receive an extended private key/i);
    expect(screen.queryByText("Depósito #0")).not.toBeInTheDocument();
  });

  it("creates a real plan and generates the next deterministic deposit without a balance", () => {
    render(<VaultForm />);
    openCreateDialog();
    fillValidPlan();
    fireEvent.click(screen.getByRole("button", { name: "Criar plano" }));
    expect(screen.getByText("PLANO LOCAL")).toBeVisible();
    expect(screen.getByText("Depósito #0")).toBeVisible();
    expect(screen.getByText("Endereços emitidos").nextElementSibling).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: /Adicionar sats a este plano/ }));
    expect(screen.getByText("Depósito #1")).toBeVisible();
    expect(screen.getByText("Endereços emitidos").nextElementSibling).toHaveTextContent("2");
    expect(screen.queryByText(/total depositado|saldo confirmado|bitcoin balance/i)).not.toBeInTheDocument();
  });

  it("offers the offline PSBT flow without ever requesting a private key", () => {
    render(<VaultForm />);
    openCreateDialog();
    fillValidPlan();
    fireEvent.click(screen.getByRole("button", { name: "Criar plano" }));
    fireEvent.click(screen.getByRole("button", { name: "Preparar gasto" }));
    expect(screen.getByRole("dialog", { name: "Preparar PSBT" })).toBeVisible();
    expect(screen.getByLabelText(/Transação de funding em raw hex/i)).toBeVisible();
    expect(screen.getByLabelText(/Endereço de destino/i)).toBeVisible();
    expect(screen.getByText(/Sua carteira assina fora desta aplicação/i)).toBeVisible();
    expect(screen.getByText(/TimeSats não transmite esta transação/i)).toBeVisible();
    expect(screen.queryByLabelText(/seed|mnemonic|private key|WIF|xprv|tprv/i)).not.toBeInTheDocument();
  });
});
