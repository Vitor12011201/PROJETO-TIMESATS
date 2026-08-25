"use client";

import { useEffect, useMemo, useState } from "react";
import { createVaultPlan, createVaultPlanRecoveryBundle, deriveIssuedDeposits, issueNextDeposit, reconstructVaultPlan, vaultPlanIdentity } from "@/bitcoin/vault-plan";
import { allowedNetworks, type AllowedNetwork } from "@/domain/vault-policy";
import type { VaultPlan } from "@/domain/vault-plan";
import { loadVaultPlans, saveVaultPlans, upsertVaultPlan } from "@/storage/vault-plan-storage";

const securityWarning = "Never enter a seed phrase or private key into TimeSats.";

function downloadJson(value: object, fileName: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function VaultForm() {
  const [network, setNetwork] = useState<AllowedNetwork>("signet");
  const [label, setLabel] = useState("");
  const [extendedPublicKey, setExtendedPublicKey] = useState("");
  const [unlockHeight, setUnlockHeight] = useState("");
  const [plans, setPlans] = useState<VaultPlan[]>([]);
  const [activePlan, setActivePlan] = useState<VaultPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [showBundle, setShowBundle] = useState(false);

  const deposits = useMemo(() => (activePlan ? deriveIssuedDeposits(activePlan) : []), [activePlan]);
  const bundle = activePlan ? createVaultPlanRecoveryBundle(activePlan) : null;

  useEffect(() => {
    const loaded = loadVaultPlans(window.localStorage);
    setPlans(loaded.plans);
    setActivePlan(loaded.plans[0] ?? null);
    setStorageError(loaded.error);
  }, []);

  function persist(nextPlans: VaultPlan[]): void {
    saveVaultPlans(window.localStorage, nextPlans);
    setPlans(nextPlans);
  }

  function createPlan(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    try {
      if (!/^\d+$/.test(unlockHeight)) throw new Error("Unlock block must be a whole block height.");
      const plan = createVaultPlan({ label, network, unlockHeight: Number(unlockHeight), extendedPublicKey: extendedPublicKey.trim() });
      persist(upsertVaultPlan(plans, plan));
      setActivePlan(plan);
      setError(null);
      setStorageError(null);
      setShowBundle(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the plan.");
    }
  }

  function addSats(): void {
    if (!activePlan) return;
    try {
      const { plan } = issueNextDeposit(activePlan);
      persist(upsertVaultPlan(plans, plan));
      setActivePlan(plan);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not issue a new deposit address.");
    }
  }

  async function copyText(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setError("Could not copy. Select the displayed value and copy manually.");
    }
  }

  async function importBundle(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = reconstructVaultPlan(JSON.parse(await file.text()));
      persist(upsertVaultPlan(plans, imported));
      setActivePlan(imported);
      setError(null);
      setStorageError(null);
      event.target.value = "";
    } catch (cause) {
      setError(cause instanceof Error ? `Could not import recovery bundle: ${cause.message}` : "Could not import recovery bundle.");
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:py-16">
      <header className="mb-10 border-b border-zinc-800 pb-8">
        <p className="mb-3 text-sm font-bold uppercase tracking-[0.2em] text-amber-400">TimeSats · v0.2</p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">TimeSats</h1>
        <p className="mt-3 text-xl text-zinc-300">Seu Bitcoin. Seu prazo. Suas chaves.</p>
        <p className="mt-2 text-zinc-400">Você escolhe o plano. O Bitcoin ajuda você a cumpri-lo.</p>
      </header>

      <section aria-label="Critical safety notices" className="mb-8 grid gap-3 sm:grid-cols-3">
        {["EXPERIMENTAL", "SIGNET / REGTEST ONLY", "DO NOT SEND REAL BITCOIN"].map((notice) => <p key={notice} className="rounded border border-amber-500/50 bg-amber-500/10 p-3 text-center text-xs font-bold tracking-wide text-amber-200">{notice}</p>)}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-5 sm:p-7">
        <h2 className="text-xl font-semibold">Criar plano</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">Um plano tem um unlock block fixo. Deposit #0 é emitido ao criar o plano; cada novo depósito recebe outra chave pública derivada e outro endereço.</p>
        <form className="mt-7 grid gap-5 sm:grid-cols-2" onSubmit={createPlan} noValidate>
          <label className="block text-sm font-medium" htmlFor="label">Nome do plano<input id="label" value={label} onChange={(event) => setLabel(event.target.value)} autoComplete="off" placeholder="Minha Casa" className="mt-2 block w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100" /></label>
          <label className="block text-sm font-medium" htmlFor="network">Network<select id="network" value={network} onChange={(event) => setNetwork(event.target.value as AllowedNetwork)} className="mt-2 block w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100">{allowedNetworks.map((item) => <option key={item} value={item}>{item === "signet" ? "Signet" : "Regtest"}</option>)}</select></label>
          <label className="block text-sm font-medium sm:col-span-2" htmlFor="extendedPublicKey">Extended public key (tpub)<input id="extendedPublicKey" name="extendedPublicKey" value={extendedPublicKey} onChange={(event) => setExtendedPublicKey(event.target.value)} autoComplete="off" spellCheck="false" placeholder="tpub… (test-network BIP32 public key)" className="mt-2 block w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100" /></label>
          <label className="block text-sm font-medium" htmlFor="unlockHeight">Unlock block<input id="unlockHeight" name="unlockHeight" inputMode="numeric" value={unlockHeight} onChange={(event) => setUnlockHeight(event.target.value)} autoComplete="off" placeholder="e.g. 840000" className="mt-2 block w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100" /></label>
          <div className="flex items-end"><button type="submit" className="w-full rounded bg-amber-400 px-5 py-2.5 text-sm font-bold text-zinc-950 hover:bg-amber-300">Criar plano</button></div>
        </form>
        {error && <p role="alert" className="mt-5 rounded border border-red-800 bg-red-950/60 p-3 text-sm text-red-200">{error}</p>}
      </section>

      <aside className="mt-6 rounded border border-amber-900/80 bg-amber-950/20 p-5 text-sm leading-6 text-amber-100"><p className="font-semibold">Privacidade da extended public key</p><p className="mt-2">Sua chave pública estendida não permite gastar seus bitcoins, mas pode revelar relações entre endereços derivados. Trate-a como informação privada de observação. Ela nunca é enviada ao TimeSats.</p></aside>

      <section className="mt-8 flex flex-wrap items-center gap-3" aria-label="Plan management">
        <label className="rounded border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800" htmlFor="bundle-import">Importar recovery bundle<input id="bundle-import" className="sr-only" type="file" accept="application/json,.json" onChange={importBundle} /></label>
        {plans.map((plan) => <button type="button" key={vaultPlanIdentity(plan)} onClick={() => { setActivePlan(plan); setError(null); setShowBundle(false); }} className={`rounded border px-3 py-2 text-sm ${activePlan && vaultPlanIdentity(activePlan) === vaultPlanIdentity(plan) ? "border-amber-400 bg-amber-400/10 text-amber-100" : "border-zinc-700 hover:bg-zinc-800"}`}>{plan.metadata.label}</button>)}
      </section>
      {storageError && <p role="alert" className="mt-5 rounded border border-red-800 bg-red-950/60 p-3 text-sm text-red-200">{storageError}</p>}

      {activePlan && bundle && <section aria-live="polite" className="mt-8 rounded-xl border border-emerald-800/70 bg-emerald-950/20 p-5 sm:p-7">
        <p className="text-xs font-bold tracking-[0.15em] text-emerald-300">VAULT PLAN · TEST NETWORK</p><h2 className="mt-2 text-2xl font-semibold">{activePlan.metadata.label}</h2>
        <dl className="mt-6 grid gap-5 text-sm sm:grid-cols-3"><Field label="Network" value={activePlan.policy.network === "signet" ? "Signet" : "Regtest"} /><Field label="Unlock block" value={String(activePlan.policy.unlockHeight)} /><Field label="Deposits issued" value={String(deposits.length)} /></dl>
        <div className="mt-7 flex flex-wrap gap-3 border-t border-emerald-900 pt-5"><button type="button" onClick={addSats} className="rounded bg-emerald-400 px-4 py-2 text-sm font-bold text-zinc-950 hover:bg-emerald-300">Adicionar sats — gerar próximo endereço</button><button type="button" onClick={() => setShowBundle((value) => !value)} className="rounded border border-zinc-600 px-3 py-2 text-sm hover:bg-zinc-800">visualizar recovery bundle</button><button type="button" onClick={() => downloadJson(bundle, `timesats-plan-${activePlan.policy.network}-${activePlan.policy.unlockHeight}.json`)} className="rounded border border-zinc-600 px-3 py-2 text-sm hover:bg-zinc-800">baixar recovery bundle</button></div>
        <div className="mt-7 space-y-5">{deposits.map((deposit) => <article key={deposit.index} className="rounded border border-zinc-800 bg-zinc-950/70 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">Deposit #{deposit.index}</h3><button type="button" onClick={() => copyText(deposit.address)} className="rounded border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800">Copiar endereço</button></div><dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2"><Field label="Address" value={deposit.address} /><Field label="Derivation" value={deposit.derivationPath} /><Field label="Public key" value={deposit.publicKey} /><Field label="Unlock" value={String(deposit.policy.unlockHeight)} /><Field label="Witness script" value={deposit.witnessScript} /><Field label="Output descriptor" value={deposit.descriptor} /></dl></article>)}</div>
        {showBundle && <pre data-testid="recovery-bundle" className="mt-6 overflow-x-auto rounded bg-zinc-950 p-4 text-xs leading-5 text-zinc-300">{JSON.stringify(bundle, null, 2)}</pre>}
      </section>}

      <aside className="mt-8 rounded border border-zinc-800 bg-zinc-900/40 p-5 text-sm leading-6 text-zinc-300"><p>{securityWarning}</p><p className="mt-3">TimeSats does not possess your private key. The Bitcoin network enforces the timelock. TimeSats cannot unlock this vault early.</p><p className="mt-3">Hard timelocks can make bitcoin unavailable even during an emergency. Losing your key means losing access. TimeSats offers no recovery and does not show an on-chain balance.</p></aside>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><dt className="mb-1 font-medium text-zinc-400">{label}</dt><dd className="break-all font-mono text-zinc-100">{value}</dd></div>;
}
