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
  deriveIssuedDeposits,
  vaultPlanIdentity,
  verifyFundingTransaction,
} from "@/bitcoin";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";
import {
  ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY,
  HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY,
  archivePlanIdentity,
  loadArchivedPlanIdentities,
  loadHiddenDepositIndexes,
  loadVaultPlans,
  saveArchivedPlanIdentities,
  saveHiddenDepositIndexes,
  saveVaultPlans,
  VAULT_PLAN_STORAGE_KEY,
} from "@/storage/vault-plan-storage";
import { VaultForm } from "./vault-form";
import { PlansGrid } from "./timesats-sections";
import { psbtBase64ToBytes } from "./psbt-file";

afterEach(() => {
  window.localStorage.removeItem(VAULT_PLAN_STORAGE_KEY);
  window.localStorage.removeItem(ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY);
  window.localStorage.removeItem(HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY);
});

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

function lifecyclePlan(label: string, unlockHeight: number, lastIssuedIndex = 0) {
  return {
    ...createVaultPlan({ label, network: "regtest", unlockHeight, extendedPublicKey: validTestTpub, policyVersion: 2, keyOrigin: validTestTpubOrigin }),
    lastIssuedIndex,
  };
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
  fireEvent.change(screen.getByLabelText(/Transação que enviou Bitcoin/i), { target: { value: rawFundingTransaction() } });
  fireEvent.change(screen.getByLabelText(/Índice da saída \(vout\)/i), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "Verificar depósito" }));
}

function generateUnsignedPsbt(): void {
  verifyValidFunding();
  fireEvent.change(screen.getByLabelText(/Endereço de destino/i), { target: { value: "bcrt1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m" } });
  fireEvent.change(screen.getByLabelText("Taxa de rede (sats)"), { target: { value: "500" } });
  fireEvent.click(screen.getByRole("button", { name: /Gerar arquivo para assinar/i }));
}

function fillSignedPsbt(): void {
  fireEvent.change(screen.getByLabelText("PSBT assinado (Base64)"), { target: { value: "previous-signed-psbt" } });
}

function expectPsbtArtifactsToBeCleared(): void {
  expect(screen.queryByText(/Arquivo pronto para assinatura/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText("PSBT assinado (Base64)")).not.toBeInTheDocument();
  expect(screen.queryByText(/raw transaction pronta para transmissão/i)).not.toBeInTheDocument();
}

function confirmNewDeposit(index: number): void {
  fireEvent.click(screen.getByRole("button", { name: `Gerar endereço #${index}` }));
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
    render(<PlansGrid activePlan={regtest} plans={[signet, regtest]} archivedPlanIdentities={[]} onCreate={vi.fn()} onSelect={onSelect} onImport={vi.fn()} onExport={vi.fn()} onArchive={vi.fn()} onRestore={vi.fn()} onRemove={vi.fn()} />);

    const signetCard = screen.getAllByRole("button", { name: /Plano Signet/i }).find((button) => button.hasAttribute("aria-pressed"));
    const regtestCard = screen.getAllByRole("button", { name: /Plano Regtest/i }).find((button) => button.hasAttribute("aria-pressed"));
    expect(signetCard).toBeDefined();
    expect(regtestCard).toBeDefined();
    if (!signetCard || !regtestCard) throw new Error("Expected both plan selection buttons.");
    expect(signetCard).toHaveAttribute("aria-pressed", "false");
    expect(regtestCard).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(signetCard);
    expect(onSelect).toHaveBeenCalledWith(signet);

    fireEvent.click(screen.getByRole("button", { name: "Opções do plano Plano Signet" }));
    const options = screen.getByRole("menu", { name: "Ações para Plano Signet" });
    fireEvent.keyDown(options, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Ações para Plano Signet" })).not.toBeInTheDocument();
  });

  it("keeps only one plan options menu open without selecting a card", () => {
    const first = lifecyclePlan("Plano A", 840_000);
    const second = lifecyclePlan("Plano B", 840_001);
    const onSelect = vi.fn();
    const onExport = vi.fn();
    render(<PlansGrid activePlan={second} plans={[first, second]} archivedPlanIdentities={[]} onCreate={vi.fn()} onSelect={onSelect} onImport={vi.fn()} onExport={onExport} onArchive={vi.fn()} onRestore={vi.fn()} onRemove={vi.fn()} />);

    const firstSelection = screen.getAllByRole("button", { name: /Plano A/i }).find((button) => button.hasAttribute("aria-pressed"));
    expect(firstSelection).toBeDefined();
    if (!firstSelection) throw new Error("Expected the Plan A selection button.");
    expect(firstSelection.querySelector("button")).toBeNull();

    const firstOptions = screen.getByRole("button", { name: "Opções do plano Plano A" });
    const secondOptions = screen.getByRole("button", { name: "Opções do plano Plano B" });
    fireEvent.click(firstOptions);
    expect(screen.getByRole("menu", { name: "Ações para Plano A" })).toBeVisible();
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(secondOptions);
    expect(screen.queryByRole("menu", { name: "Ações para Plano A" })).not.toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Ações para Plano B" })).toBeVisible();
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(secondOptions);
    expect(screen.queryByRole("menu", { name: "Ações para Plano B" })).not.toBeInTheDocument();

    fireEvent.click(firstOptions);
    fireEvent.keyDown(screen.getByRole("menu", { name: "Ações para Plano A" }), { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Ações para Plano A" })).not.toBeInTheDocument();

    fireEvent.click(firstOptions);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "Ações para Plano A" })).not.toBeInTheDocument();

    fireEvent.click(firstOptions);
    fireEvent.click(screen.getByRole("menuitem", { name: "Exportar recovery" }));
    expect(onExport).toHaveBeenCalledWith(first);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows test-network warnings, never offers mainnet, and keeps semantic navigation", () => {
    render(<VaultForm />);
    expect(screen.getByText(/Experimental software\. Signet \/ Regtest only/i)).toBeVisible();
    expect(screen.getByText(/Do not send real bitcoin/i)).toBeVisible();
    expect(screen.queryByRole("option", { name: /mainnet/i })).not.toBeInTheDocument();
    openCreateDialog();
    expect(screen.getByRole("dialog", { name: /Crie seu compromisso/i })).toBeVisible();
    expect(screen.getByText(/nunca pede seed ou chave privada/i)).toBeVisible();
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
    expect(screen.getByText("PLANO ATIVO")).toBeVisible();
    expect(screen.getByText("Depósito #0")).toBeVisible();
    const activePlan = screen.getByLabelText("Plano ativo Minha Casa");
    expect(within(activePlan).getByText("Endereços emitidos").nextElementSibling).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: /Adicionar Bitcoin/ }));
    expect(screen.getByRole("dialog", { name: "Gerar novo endereço?" })).toBeVisible();
    confirmNewDeposit(1);
    expect(screen.getByText("Depósito #1")).toBeVisible();
    expect(within(activePlan).getByText("Endereços emitidos").nextElementSibling).toHaveTextContent("2");
    expect(screen.queryByText(/total depositado|saldo confirmado|bitcoin balance/i)).not.toBeInTheDocument();
  });

  it("requires an explicit confirmation to issue exactly one new deposit", () => {
    render(<VaultForm />);
    openCreateDialog();
    fillValidPlan();
    fireEvent.click(screen.getByRole("button", { name: "Criar plano" }));
    const active = screen.getByLabelText("Plano ativo Minha Casa");

    fireEvent.click(screen.getByRole("button", { name: "Adicionar Bitcoin" }));
    expect(within(active).getByText("Endereços emitidos").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByRole("dialog", { name: "Gerar novo endereço?" })).toHaveTextContent("Próximo depósito#1");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(within(active).getByText("Endereços emitidos").nextElementSibling).toHaveTextContent("1");

    fireEvent.click(screen.getByRole("button", { name: "Adicionar Bitcoin" }));
    fireEvent.click(screen.getByRole("button", { name: "Fechar geração de endereço" }));
    expect(within(active).getByText("Endereços emitidos").nextElementSibling).toHaveTextContent("1");

    fireEvent.click(screen.getByRole("button", { name: "Adicionar Bitcoin" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Gerar novo endereço?" })).not.toBeInTheDocument();
    expect(within(active).getByText("Endereços emitidos").nextElementSibling).toHaveTextContent("1");

    fireEvent.click(screen.getByRole("button", { name: "Adicionar Bitcoin" }));
    const confirmation = screen.getByRole("button", { name: "Gerar endereço #1" });
    fireEvent.click(confirmation);
    fireEvent.click(confirmation);
    expect(screen.getByText("Depósito #1")).toBeVisible();
    expect(screen.queryByText("Depósito #2")).not.toBeInTheDocument();
    expect(loadVaultPlans(window.localStorage).plans[0].lastIssuedIndex).toBe(1);
  });

  it("hides an emitted deposit only from the active list and restores it without changing recovery", () => {
    const plan = lifecyclePlan("Endereços locais", 840_000, 3);
    const identity = vaultPlanIdentity(plan);
    const recoveryBeforeHide = createVaultPlanRecoveryBundle(plan);
    saveVaultPlans(window.localStorage, [plan]);
    render(<VaultForm />);
    const active = screen.getByLabelText("Plano ativo Endereços locais");

    fireEvent.click(screen.getByRole("button", { name: "Opções do depósito 3" }));
    expect(screen.queryByRole("dialog", { name: "Preparar gasto" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Ocultar da lista" }));
    const hideDialog = screen.getByRole("dialog", { name: "Ocultar este endereço?" });
    fireEvent.click(within(hideDialog).getByRole("button", { name: "Cancelar" }));
    expect(screen.getByText("Depósito #3")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Opções do depósito 3" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Ocultar da lista" }));
    fireEvent.click(screen.getByRole("button", { name: "Ocultar endereço" }));
    expect(screen.queryByText("Depósito #3")).not.toBeInTheDocument();
    expect(within(active).getByText("Endereços emitidos").nextElementSibling).toHaveTextContent("4");
    expect(within(active).getByText("Próximo índice").nextElementSibling).toHaveTextContent("#4");
    expect(loadHiddenDepositIndexes(window.localStorage)).toEqual({ [identity]: [3] });
    expect(loadVaultPlans(window.localStorage).plans[0].lastIssuedIndex).toBe(3);
    expect(vaultPlanIdentity(loadVaultPlans(window.localStorage).plans[0])).toBe(identity);
    expect(createVaultPlanRecoveryBundle(loadVaultPlans(window.localStorage).plans[0])).toEqual(recoveryBeforeHide);
    expect(deriveIssuedDeposits(loadVaultPlans(window.localStorage).plans[0]).map((deposit) => deposit.index)).toEqual([0, 1, 2, 3]);

    fireEvent.click(screen.getByRole("button", { name: "Ver ocultos (1)" }));
    expect(screen.getByRole("heading", { name: "Endereços ocultos" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Mostrar novamente" }));
    expect(screen.getByText("Depósito #3")).toBeVisible();
    expect(loadHiddenDepositIndexes(window.localStorage)).toEqual({});
  });

  it("keeps hidden deposits emitted and advances to the next unused index", () => {
    const plan = lifecyclePlan("Próximo índice", 840_000, 3);
    const identity = vaultPlanIdentity(plan);
    saveVaultPlans(window.localStorage, [plan]);
    saveHiddenDepositIndexes(window.localStorage, { [identity]: [3] });
    render(<VaultForm />);

    expect(screen.queryByText("Depósito #3")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Adicionar Bitcoin" }));
    expect(screen.getByRole("dialog", { name: "Gerar novo endereço?" })).toHaveTextContent("Próximo depósito#4");
    confirmNewDeposit(4);

    expect(screen.getByText("Depósito #4")).toBeVisible();
    expect(screen.queryByText("Depósito #3")).not.toBeInTheDocument();
    expect(loadVaultPlans(window.localStorage).plans[0].lastIssuedIndex).toBe(4);
    expect(loadHiddenDepositIndexes(window.localStorage)).toEqual({ [identity]: [3] });
  });

  it("shows a useful empty state when every emitted deposit is hidden", () => {
    const plan = lifecyclePlan("Tudo oculto", 840_000);
    saveVaultPlans(window.localStorage, [plan]);
    saveHiddenDepositIndexes(window.localStorage, { [vaultPlanIdentity(plan)]: [0] });
    render(<VaultForm />);

    expect(screen.getByText("Nenhum endereço visível")).toBeVisible();
    expect(screen.getByText(/possui 1 endereços emitidos/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Ver ocultos (1)" }));
    expect(screen.getByText("Depósito #0")).toBeVisible();
  });

  it("keeps only one deposit options menu open without preparing a spend", () => {
    const plan = lifecyclePlan("Menus de depósito", 840_000, 1);
    saveVaultPlans(window.localStorage, [plan]);
    render(<VaultForm />);

    const firstOptions = screen.getByRole("button", { name: "Opções do depósito 0" });
    const secondOptions = screen.getByRole("button", { name: "Opções do depósito 1" });
    fireEvent.click(firstOptions);
    expect(screen.getByRole("menu", { name: "Ações para depósito 0" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Preparar gasto" })).not.toBeInTheDocument();

    fireEvent.click(secondOptions);
    expect(screen.queryByRole("menu", { name: "Ações para depósito 0" })).not.toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Ações para depósito 1" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("menu", { name: "Ações para depósito 1" }), { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Ações para depósito 1" })).not.toBeInTheDocument();

    fireEvent.click(firstOptions);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "Ações para depósito 0" })).not.toBeInTheDocument();
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

  it("archives the active plan locally and selects the first remaining visible plan", async () => {
    const first = lifecyclePlan("Plano principal", 840_000);
    const second = lifecyclePlan("Plano alternativo", 840_001);
    saveVaultPlans(window.localStorage, [first, second]);
    render(<VaultForm />);
    await screen.findByLabelText("Plano ativo Plano principal");

    fireEvent.click(screen.getByRole("button", { name: "Opções do plano Plano principal" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Arquivar" }));
    expect(screen.getByRole("dialog", { name: "Arquivar plano?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Arquivar" }));

    expect(await screen.findByLabelText("Plano ativo Plano alternativo")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Plano principal/i })).not.toBeInTheDocument();
    expect(loadArchivedPlanIdentities(window.localStorage)).toEqual([vaultPlanIdentity(first)]);
    expect(loadVaultPlans(window.localStorage).plans).toEqual([first, second]);
  });

  it("archives and restores a plan without changing its identity or issuance state", async () => {
    const plan = lifecyclePlan("Plano para arquivar", 840_000, 5);
    const identity = vaultPlanIdentity(plan);
    saveVaultPlans(window.localStorage, [plan]);
    saveHiddenDepositIndexes(window.localStorage, { [identity]: [2, 4] });
    render(<VaultForm />);
    await screen.findByLabelText("Plano ativo Plano para arquivar");

    fireEvent.click(screen.getByRole("button", { name: "Opções do plano Plano para arquivar" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Arquivar" }));
    fireEvent.click(screen.getByRole("button", { name: "Arquivar" }));
    expect(await screen.findByText("Nenhum plano ativo.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Ver arquivados" }));
    expect(screen.getByRole("heading", { name: "Planos arquivados" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Opções do plano Plano para arquivar" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Restaurar" }));

    expect(screen.getAllByRole("button", { name: /Plano para arquivar/i }).find((button) => button.hasAttribute("aria-pressed"))).toBeVisible();
    expect(loadArchivedPlanIdentities(window.localStorage)).toEqual([]);
    expect(loadHiddenDepositIndexes(window.localStorage)).toEqual({ [identity]: [2, 4] });
    expect(loadVaultPlans(window.localStorage).plans).toEqual([plan]);
    expect(vaultPlanIdentity(loadVaultPlans(window.localStorage).plans[0])).toBe(vaultPlanIdentity(plan));
  });

  it("allows local removal only after acknowledgement and clears the archive marker", async () => {
    const plan = lifecyclePlan("Plano para remover", 840_000);
    saveVaultPlans(window.localStorage, [plan]);
    saveArchivedPlanIdentities(window.localStorage, archivePlanIdentity([], vaultPlanIdentity(plan)));
    saveHiddenDepositIndexes(window.localStorage, { [vaultPlanIdentity(plan)]: [0] });
    render(<VaultForm />);
    await screen.findByText("Nenhum plano ativo.");
    fireEvent.click(screen.getByRole("button", { name: "Ver arquivados" }));
    fireEvent.click(screen.getByRole("button", { name: "Opções do plano Plano para remover" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remover deste dispositivo" }));

    const dialog = screen.getByRole("dialog", { name: "Remover este plano deste dispositivo?" });
    expect(within(dialog).getByRole("button", { name: "Baixar recovery" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Remover deste dispositivo" })).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText(/Entendo que precisarei do recovery/i));
    fireEvent.click(within(dialog).getByRole("button", { name: "Remover deste dispositivo" }));

    expect(loadVaultPlans(window.localStorage).plans).toEqual([]);
    expect(loadArchivedPlanIdentities(window.localStorage)).toEqual([]);
    expect(loadHiddenDepositIndexes(window.localStorage)).toEqual({});
    expect(screen.getByText("Nenhum plano criado ainda.")).toBeVisible();
  });

  it("removes an active normal plan locally and selects the first remaining visible plan", async () => {
    const first = lifecyclePlan("Plano a remover", 840_000);
    const second = lifecyclePlan("Plano que permanece", 840_001);
    saveVaultPlans(window.localStorage, [first, second]);
    render(<VaultForm />);
    await screen.findByLabelText("Plano ativo Plano a remover");

    fireEvent.click(screen.getByRole("button", { name: "Opções do plano Plano a remover" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remover deste dispositivo" }));
    const dialog = screen.getByRole("dialog", { name: "Remover este plano deste dispositivo?" });
    fireEvent.click(within(dialog).getByLabelText(/Entendo que precisarei do recovery/i));
    fireEvent.click(within(dialog).getByRole("button", { name: "Remover deste dispositivo" }));

    expect(await screen.findByLabelText("Plano ativo Plano que permanece")).toBeVisible();
    expect(loadVaultPlans(window.localStorage).plans).toEqual([second]);
    expect(loadArchivedPlanIdentities(window.localStorage)).toEqual([]);
  });

  it("keeps an imported recovery archived without creating a duplicate and resumes issuance after local removal", async () => {
    const plan = lifecyclePlan("Recovery local", 840_000, 5);
    const bundle = createVaultPlanRecoveryBundle(plan);
    saveVaultPlans(window.localStorage, [plan]);
    saveArchivedPlanIdentities(window.localStorage, [vaultPlanIdentity(plan)]);
    saveHiddenDepositIndexes(window.localStorage, { [vaultPlanIdentity(plan)]: [2, 4] });
    render(<VaultForm />);
    await screen.findByText("Nenhum plano ativo.");

    fireEvent.change(screen.getByLabelText("Importar recovery bundle"), {
      target: { files: [{ text: vi.fn().mockResolvedValue(JSON.stringify(bundle)) }] },
    });
    await waitFor(() => expect(loadVaultPlans(window.localStorage).plans).toEqual([plan]));
    expect(loadArchivedPlanIdentities(window.localStorage)).toEqual([vaultPlanIdentity(plan)]);
    expect(loadHiddenDepositIndexes(window.localStorage)).toEqual({ [vaultPlanIdentity(plan)]: [2, 4] });

    fireEvent.click(screen.getByRole("button", { name: "Ver arquivados" }));
    fireEvent.click(screen.getByRole("button", { name: "Opções do plano Recovery local" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remover deste dispositivo" }));
    fireEvent.click(screen.getByLabelText(/Entendo que precisarei do recovery/i));
    fireEvent.click(screen.getByRole("button", { name: "Remover deste dispositivo" }));
    expect(loadVaultPlans(window.localStorage).plans).toEqual([]);
    expect(loadHiddenDepositIndexes(window.localStorage)).toEqual({});

    fireEvent.change(screen.getByLabelText("Importar recovery bundle"), {
      target: { files: [{ text: vi.fn().mockResolvedValue(JSON.stringify(bundle)) }] },
    });
    const active = await screen.findByLabelText("Plano ativo Recovery local");
    expect(within(active).getByText("Endereços emitidos").nextElementSibling).toHaveTextContent("6");
    fireEvent.click(screen.getByRole("button", { name: "Adicionar Bitcoin" }));
    confirmNewDeposit(6);
    expect(screen.getByText("Depósito #6")).toBeVisible();
    expect(loadVaultPlans(window.localStorage).plans[0].lastIssuedIndex).toBe(6);
    expect(loadHiddenDepositIndexes(window.localStorage)).toEqual({});
  });

  it("cancels local removal without changing the stored plan", async () => {
    const plan = lifecyclePlan("Plano mantido", 840_000);
    saveVaultPlans(window.localStorage, [plan]);
    render(<VaultForm />);
    await screen.findByLabelText("Plano ativo Plano mantido");
    fireEvent.click(screen.getByRole("button", { name: "Opções do plano Plano mantido" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remover deste dispositivo" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(loadVaultPlans(window.localStorage).plans).toEqual([plan]);
    expect(screen.getByLabelText("Plano ativo Plano mantido")).toBeVisible();
  });

  it("offers the offline PSBT flow without ever requesting a private key", () => {
    render(<VaultForm />);
    openCreateDialog();
    fillValidPlan();
    fireEvent.click(screen.getByRole("button", { name: "Criar plano" }));
    fireEvent.click(screen.getByRole("button", { name: "Preparar gasto" }));
    expect(screen.getByRole("dialog", { name: "Preparar gasto" })).toBeVisible();
    expect(screen.getByLabelText(/Transação que enviou Bitcoin/i)).toBeVisible();
    expect(screen.getByLabelText(/Endereço de destino/i)).toBeVisible();
    expect(screen.getByText(/Sua carteira assina fora desta aplicação/i)).toBeVisible();
    expect(screen.getByText(/não transmite a transação/i)).toBeVisible();
    expect(screen.queryByLabelText(/seed|mnemonic|private key|WIF|xprv|tprv/i)).not.toBeInTheDocument();
  });

  it("verifies manual funding before enabling PSBT preparation", () => {
    createPlanAndOpenSpend();
    const generate = screen.getByRole("button", { name: /Gerar arquivo para assinar/i });
    expect(generate).toBeDisabled();

    verifyValidFunding();

    expect(screen.getAllByText("Depósito verificado")[0]).toBeVisible();
    expect(generate).toBeEnabled();
  });

  it("keeps PSBT preparation blocked when manual funding is invalid", () => {
    createPlanAndOpenSpend();
    fireEvent.change(screen.getByLabelText(/Transação que enviou Bitcoin/i), { target: { value: "not-hex" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar depósito" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/valid raw transaction hexadecimal/i);
    expect(screen.queryByText("Depósito verificado")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Gerar arquivo para assinar/i })).toBeDisabled();
  });

  it("produces an unsigned PSBT after verified funding and valid spend details", () => {
    createPlanAndOpenSpend();

    generateUnsignedPsbt();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/Arquivo pronto para assinatura/)).toBeVisible();
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
    fireEvent.change(screen.getByLabelText(/Transação que enviou Bitcoin/i), { target: { value: context.fundingHex } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar depósito" }));
    fireEvent.change(screen.getByLabelText(/Endereço de destino/i), { target: { value: context.destination } });
    fireEvent.click(screen.getByRole("button", { name: /Gerar arquivo para assinar/i }));
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
    expect(screen.getAllByText("Depósito verificado")[0]).toBeVisible();
    fireEvent.change(screen.getByLabelText(/Endereço de destino/i), { target: { value: "bcrt1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m" } });
    fireEvent.click(screen.getByRole("button", { name: /Gerar arquivo para assinar/i }));
    expect(screen.getByLabelText("PSBT assinado (Base64)")).toHaveValue("");
  });

  it("clears an old PSBT and signed PSBT when the fee changes", () => {
    createPlanAndOpenSpend();
    generateUnsignedPsbt();
    fillSignedPsbt();

    fireEvent.change(screen.getByLabelText("Taxa de rede (sats)"), { target: { value: "700" } });

    expectPsbtArtifactsToBeCleared();
    expect(screen.getAllByText("Depósito verificado")[0]).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Gerar arquivo para assinar/i }));
    expect(screen.getByLabelText("PSBT assinado (Base64)")).toHaveValue("");
  });

  it("clears verified funding and all downstream artifacts when funding raw transaction changes", () => {
    createPlanAndOpenSpend();
    generateUnsignedPsbt();
    fillSignedPsbt();

    fireEvent.change(screen.getByLabelText(/Transação que enviou Bitcoin/i), { target: { value: "not-hex" } });

    expect(screen.queryByText("Depósito verificado")).not.toBeInTheDocument();
    expectPsbtArtifactsToBeCleared();
    fireEvent.change(screen.getByLabelText(/Transação que enviou Bitcoin/i), { target: { value: rawFundingTransaction() } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar depósito" }));
    fireEvent.click(screen.getByRole("button", { name: /Gerar arquivo para assinar/i }));
    expect(screen.getByLabelText("PSBT assinado (Base64)")).toHaveValue("");
  });

  it("clears verified funding and all downstream artifacts when vout changes", () => {
    createPlanAndOpenSpend();
    generateUnsignedPsbt();
    fillSignedPsbt();

    fireEvent.change(screen.getByLabelText(/Índice da saída \(vout\)/i), { target: { value: "1" } });

    expect(screen.queryByText("Depósito verificado")).not.toBeInTheDocument();
    expectPsbtArtifactsToBeCleared();
    fireEvent.change(screen.getByLabelText(/Índice da saída \(vout\)/i), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar depósito" }));
    fireEvent.click(screen.getByRole("button", { name: /Gerar arquivo para assinar/i }));
    expect(screen.getByLabelText("PSBT assinado (Base64)")).toHaveValue("");
  });
});
