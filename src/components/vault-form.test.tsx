import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { Psbt, Transaction } from "bitcoinjs-lib";
import { bitcoinNetworkFor } from "@/bitcoin/networks";
import { testnetBip32Versions } from "@/bitcoin/bip32";
import {
  buildUnsignedVaultPsbt,
  createVaultPlan,
  createVaultPlanRecoveryBundle,
  createVaultSpendIntent,
  deriveDeposit,
  vaultPlanIdentity,
  verifyFundingTransaction,
} from "@/bitcoin";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";
import { loadVaultPlans, saveVaultPlans, VAULT_PLAN_STORAGE_KEY } from "@/storage/vault-plan-storage";
import { VaultForm } from "./vault-form";
import { PlansGrid } from "./timesats-sections";
import { psbtBase64ToBytes } from "./psbt-file";

afterEach(() => window.localStorage.removeItem(VAULT_PLAN_STORAGE_KEY));

function openCreateDialog(): void {
  fireEvent.click(screen.getAllByRole("button", { name: "Criar meu plano" })[0]);
}

function fillValidPlan(): void {
  fireEvent.change(screen.getByLabelText("Nome do plano"), { target: { value: "Minha Casa" } });
  fireEvent.change(screen.getByLabelText("Rede"), { target: { value: "regtest" } });
  fireEvent.change(screen.getByLabelText(/Chave pública estendida/), { target: { value: validTestTpub } });
  fireEvent.change(screen.getByLabelText(/Fingerprint mestre público/), { target: { value: validTestTpubOrigin.masterFingerprint } });
  fireEvent.change(screen.getByLabelText(/Caminho absoluto da tpub/), { target: { value: validTestTpubOrigin.sourcePath } });
  fireEvent.change(screen.getByLabelText("Bloco de desbloqueio"), { target: { value: "840000" } });
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function rawFundingTransaction(): string {
  const plan = createVaultPlan({
    label: "Minha Casa",
    network: "regtest",
    unlockHeight: 840_000,
    extendedPublicKey: validTestTpub,
    policyVersion: 2,
    keyOrigin: validTestTpubOrigin,
  });
  const funding = new Transaction();
  funding.addInput(new Uint8Array(32).fill(0x44), 0);
  funding.addOutput(hexToUint8Array(deriveDeposit(plan, 0).outputScript), 500_000n);
  return funding.toHex();
}

function signedV2SpendContext() {
  const root = HDKey.fromMasterSeed(randomBytes(32), testnetBip32Versions);
  const child = root.deriveChild(0);
  if (!child.privateKey || !child.publicKey) throw new Error("Test signer key unavailable.");
  const plan = createVaultPlan({
    label: "Assinatura de teste",
    network: "regtest",
    unlockHeight: 840_000,
    extendedPublicKey: root.publicExtendedKey,
    policyVersion: 2,
    keyOrigin: { masterFingerprint: root.fingerprint.toString(16).padStart(8, "0"), sourcePath: "m" },
  });
  const funding = new Transaction();
  funding.addInput(new Uint8Array(32).fill(0x45), 0);
  funding.addOutput(hexToUint8Array(deriveDeposit(plan, 0).outputScript), 500_000n);
  const verified = verifyFundingTransaction(plan, 0, funding.toHex(), 0);
  const destination = "bcrt1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m";
  const intent = createVaultSpendIntent(verified.utxo, destination, 500);
  const psbt = Psbt.fromBase64(buildUnsignedVaultPsbt(intent, verified.utxo).base64, { network: bitcoinNetworkFor("regtest") });
  psbt.signInput(0, {
    publicKey: child.publicKey,
    sign(hash) {
      return secp256k1.sign(hash, child.privateKey!, { prehash: false, format: "compact" });
    },
  });
  return { plan, fundingHex: funding.toHex(), signedBase64: psbt.toBase64(), destination };
}

function createPlanAndOpenSpend(): void {
  render(<VaultForm />);
  openCreateDialog();
  fillValidPlan();
  fireEvent.click(screen.getByRole("button", { name: "Criar plano" }));
  fireEvent.click(screen.getByRole("button", { name: "Preparar gasto" }));
}

function verifyValidFunding(): void {
  fireEvent.change(screen.getByLabelText(/Transação de funding em raw hex/i), { target: { value: rawFundingTransaction() } });
  fireEvent.change(screen.getByLabelText("Vout"), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "Verificar UTXO" }));
}

function generateUnsignedPsbt(): void {
  verifyValidFunding();
  fireEvent.change(screen.getByLabelText(/Endereço de destino/i), { target: { value: "bcrt1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m" } });
  fireEvent.change(screen.getByLabelText("Fee (sats)"), { target: { value: "500" } });
  fireEvent.click(screen.getByRole("button", { name: /Gerar PSBT não assinado/i }));
}

function fillSignedPsbt(): void {
  fireEvent.change(screen.getByLabelText("PSBT assinado (Base64)"), { target: { value: "previous-signed-psbt" } });
}

function expectPsbtArtifactsToBeCleared(): void {
  expect(screen.queryByText(/PSBT pronto/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText("PSBT assinado (Base64)")).not.toBeInTheDocument();
  expect(screen.queryByText(/raw transaction pronta para transmissão/i)).not.toBeInTheDocument();
}

describe("VaultForm", () => {
  it("keeps same-key same-height plans on different networks visibly distinct", () => {
    const shared = { unlockHeight: 840_000, extendedPublicKey: validTestTpub };
    const signet = createVaultPlan({ ...shared, label: "Plano Signet", network: "signet" });
    const regtest = createVaultPlan({ ...shared, label: "Plano Regtest", network: "regtest" });
    const v2 = createVaultPlan({ ...shared, label: "Plano V2", network: "regtest", policyVersion: 2, keyOrigin: validTestTpubOrigin });
    const onSelect = vi.fn();

    expect(vaultPlanIdentity(signet)).not.toBe(vaultPlanIdentity(regtest));
    expect(vaultPlanIdentity(v2)).not.toBe(vaultPlanIdentity(regtest));
    render(<PlansGrid activePlan={regtest} plans={[signet, regtest]} onCreate={vi.fn()} onSelect={onSelect} onImport={vi.fn()} />);

    const signetCard = screen.getByRole("button", { name: /Plano Signet/i });
    const regtestCard = screen.getByRole("button", { name: /Plano Regtest/i });
    expect(signetCard).toHaveAttribute("aria-pressed", "false");
    expect(regtestCard).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(signetCard);
    expect(onSelect).toHaveBeenCalledWith(signet);
  });

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

  it("keeps the active plan and storage at the highest issued index after importing older recovery", async () => {
    const existing = {
      ...createVaultPlan({ label: "Estado local", network: "regtest", unlockHeight: 840_000, extendedPublicKey: validTestTpub, policyVersion: 2, keyOrigin: validTestTpubOrigin }),
      lastIssuedIndex: 5,
    };
    const incoming = {
      ...createVaultPlan({ label: "Recovery importado", network: "regtest", unlockHeight: 840_000, extendedPublicKey: validTestTpub, policyVersion: 2, keyOrigin: validTestTpubOrigin }),
      lastIssuedIndex: 1,
    };
    saveVaultPlans(window.localStorage, [existing]);
    render(<VaultForm />);
    await waitFor(() => expect(screen.getByLabelText("Plano ativo Estado local")).toBeVisible());

    fireEvent.change(screen.getByLabelText("Importar recovery bundle"), {
      target: { files: [{ text: vi.fn().mockResolvedValue(JSON.stringify(createVaultPlanRecoveryBundle(incoming))) }] },
    });

    const active = await screen.findByLabelText("Plano ativo Recovery importado");
    expect(within(active).getByText("Endereços emitidos").nextElementSibling).toHaveTextContent("6");
    expect(loadVaultPlans(window.localStorage).plans).toEqual([{ ...incoming, lastIssuedIndex: 5 }]);
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

  it("verifies manual funding before enabling PSBT preparation", () => {
    createPlanAndOpenSpend();
    const generate = screen.getByRole("button", { name: /Gerar PSBT não assinado/i });
    expect(generate).toBeDisabled();

    verifyValidFunding();

    expect(screen.getByText("UTXO verificado")).toBeVisible();
    expect(generate).toBeEnabled();
  });

  it("keeps PSBT preparation blocked when manual funding is invalid", () => {
    createPlanAndOpenSpend();
    fireEvent.change(screen.getByLabelText(/Transação de funding em raw hex/i), { target: { value: "not-hex" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar UTXO" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/valid raw transaction hexadecimal/i);
    expect(screen.queryByText("UTXO verificado")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Gerar PSBT não assinado/i })).toBeDisabled();
  });

  it("produces an unsigned PSBT after verified funding and valid spend details", () => {
    createPlanAndOpenSpend();

    generateUnsignedPsbt();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/PSBT pronto/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Copiar Base64" })).toBeVisible();
  });

  it("does not show a final transaction when the signed PSBT is invalid", () => {
    createPlanAndOpenSpend();
    generateUnsignedPsbt();
    fireEvent.change(screen.getByLabelText("PSBT assinado (Base64)"), { target: { value: "not-a-psbt" } });
    fireEvent.click(screen.getByRole("button", { name: "Validar e finalizar" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/malformed|unsupported/i);
    expect(screen.queryByText(/raw transaction pronta para transmissão/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Raw transaction final pronta para transmissão/i)).not.toBeInTheDocument();
  });

  it("imports a binary PSBT file into Base64 and clears stale signed state", async () => {
    createPlanAndOpenSpend();
    generateUnsignedPsbt();
    fillSignedPsbt();
    const importedBase64 = new Psbt().toBase64();

    fireEvent.change(screen.getByLabelText("Importar PSBT assinado"), {
      target: { files: [{ arrayBuffer: vi.fn().mockResolvedValue(psbtBase64ToBytes(importedBase64).buffer) }] },
    });

    await waitFor(() => expect(screen.getByLabelText("PSBT assinado (Base64)")).toHaveValue(importedBase64));
    expect(screen.queryByLabelText("Raw transaction final pronta para transmissão")).not.toBeInTheDocument();
  });

  it("clears stale signed state when an imported PSBT file is invalid", async () => {
    createPlanAndOpenSpend();
    generateUnsignedPsbt();
    fillSignedPsbt();

    fireEvent.change(screen.getByLabelText("Importar PSBT assinado"), {
      target: { files: [{ arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode("not a psbt").buffer) }] },
    });

    await waitFor(() => expect(screen.getByLabelText("PSBT assinado (Base64)")).toHaveValue(""));
    expect(screen.getByRole("alert")).toHaveTextContent(/BIP174|Base64/i);
  });

  it("invalidates a finalized transaction when a replacement PSBT file is imported", async () => {
    const context = signedV2SpendContext();
    saveVaultPlans(window.localStorage, [context.plan]);
    render(<VaultForm />);
    await screen.findByLabelText("Plano ativo Assinatura de teste");
    fireEvent.click(screen.getByRole("button", { name: "Preparar gasto" }));
    fireEvent.change(screen.getByLabelText(/Transação de funding em raw hex/i), { target: { value: context.fundingHex } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar UTXO" }));
    fireEvent.change(screen.getByLabelText(/Endereço de destino/i), { target: { value: context.destination } });
    fireEvent.click(screen.getByRole("button", { name: /Gerar PSBT não assinado/i }));
    fireEvent.change(screen.getByLabelText("PSBT assinado (Base64)"), { target: { value: context.signedBase64 } });
    fireEvent.click(screen.getByRole("button", { name: "Validar e finalizar" }));
    expect(await screen.findByLabelText("Raw transaction final pronta para transmissão")).toBeVisible();

    fireEvent.change(screen.getByLabelText("Importar PSBT assinado"), {
      target: { files: [{ arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode("not a psbt").buffer) }] },
    });

    await waitFor(() => expect(screen.queryByLabelText("Raw transaction final pronta para transmissão")).not.toBeInTheDocument());
    expect(screen.getByLabelText("PSBT assinado (Base64)")).toHaveValue("");
  });

  it("clears an old PSBT and signed PSBT when the destination changes", () => {
    createPlanAndOpenSpend();
    generateUnsignedPsbt();
    fillSignedPsbt();

    fireEvent.change(screen.getByLabelText(/Endereço de destino/i), { target: { value: "not-a-destination" } });

    expectPsbtArtifactsToBeCleared();
    expect(screen.getByText("UTXO verificado")).toBeVisible();
    fireEvent.change(screen.getByLabelText(/Endereço de destino/i), { target: { value: "bcrt1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m" } });
    fireEvent.click(screen.getByRole("button", { name: /Gerar PSBT não assinado/i }));
    expect(screen.getByLabelText("PSBT assinado (Base64)")).toHaveValue("");
  });

  it("clears an old PSBT and signed PSBT when the fee changes", () => {
    createPlanAndOpenSpend();
    generateUnsignedPsbt();
    fillSignedPsbt();

    fireEvent.change(screen.getByLabelText("Fee (sats)"), { target: { value: "700" } });

    expectPsbtArtifactsToBeCleared();
    expect(screen.getByText("UTXO verificado")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Gerar PSBT não assinado/i }));
    expect(screen.getByLabelText("PSBT assinado (Base64)")).toHaveValue("");
  });

  it("clears verified funding and all downstream artifacts when funding raw transaction changes", () => {
    createPlanAndOpenSpend();
    generateUnsignedPsbt();
    fillSignedPsbt();

    fireEvent.change(screen.getByLabelText(/Transação de funding em raw hex/i), { target: { value: "not-hex" } });

    expect(screen.queryByText("UTXO verificado")).not.toBeInTheDocument();
    expectPsbtArtifactsToBeCleared();
    fireEvent.change(screen.getByLabelText(/Transação de funding em raw hex/i), { target: { value: rawFundingTransaction() } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar UTXO" }));
    fireEvent.click(screen.getByRole("button", { name: /Gerar PSBT não assinado/i }));
    expect(screen.getByLabelText("PSBT assinado (Base64)")).toHaveValue("");
  });

  it("clears verified funding and all downstream artifacts when vout changes", () => {
    createPlanAndOpenSpend();
    generateUnsignedPsbt();
    fillSignedPsbt();

    fireEvent.change(screen.getByLabelText("Vout"), { target: { value: "1" } });

    expect(screen.queryByText("UTXO verificado")).not.toBeInTheDocument();
    expectPsbtArtifactsToBeCleared();
    fireEvent.change(screen.getByLabelText("Vout"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar UTXO" }));
    fireEvent.click(screen.getByRole("button", { name: /Gerar PSBT não assinado/i }));
    expect(screen.getByLabelText("PSBT assinado (Base64)")).toHaveValue("");
  });
});
