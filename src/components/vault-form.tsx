"use client";

import { useState } from "react";
import { createRecoveryBundle, type RecoveryBundle } from "@/bitcoin/vault";
import { allowedNetworks, VAULT_POLICY_VERSION, type AllowedNetwork } from "@/domain/vault-policy";

const securityWarning = "Never enter a seed phrase or private key into TimeSats.";

function downloadBundle(bundle: RecoveryBundle): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `timesats-${bundle.network}-${bundle.unlockHeight}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function VaultForm() {
  const [network, setNetwork] = useState<AllowedNetwork>("signet");
  const [publicKey, setPublicKey] = useState("");
  const [unlockHeight, setUnlockHeight] = useState("");
  const [bundle, setBundle] = useState<RecoveryBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBundle, setShowBundle] = useState(false);

  function createVault(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setBundle(null);
    setShowBundle(false);
    try {
      if (!/^\d+$/.test(unlockHeight)) {
        throw new Error("Unlock block must be a whole block height.");
      }
      const nextBundle = createRecoveryBundle({
        version: VAULT_POLICY_VERSION,
        network,
        publicKey: publicKey.trim(),
        unlockHeight: Number(unlockHeight),
      });
      setBundle(nextBundle);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the test vault.");
    }
  }

  async function copyBundle(): Promise<void> {
    if (!bundle) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
    } catch {
      setError("Could not copy the recovery bundle. Select it and copy manually.");
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-5 py-10 sm:py-16">
      <header className="mb-10 border-b border-zinc-800 pb-8">
        <p className="mb-3 text-sm font-bold uppercase tracking-[0.2em] text-amber-400">TimeSats · v0.1</p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">TimeSats</h1>
        <p className="mt-3 text-xl text-zinc-300">Seu Bitcoin. Seu prazo. Suas chaves.</p>
      </header>

      <section aria-label="Critical safety notices" className="mb-8 grid gap-3 sm:grid-cols-3">
        {["EXPERIMENTAL", "SIGNET / REGTEST ONLY", "DO NOT SEND REAL BITCOIN"].map((notice) => (
          <p key={notice} className="rounded border border-amber-500/50 bg-amber-500/10 p-3 text-center text-xs font-bold tracking-wide text-amber-200">{notice}</p>
        ))}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-5 sm:p-7">
        <h2 className="text-xl font-semibold">Criar cofre de teste</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">Informe somente uma public key de teste e uma altura futura. Blocos não têm horário exato.</p>
        <form className="mt-7 space-y-5" onSubmit={createVault} noValidate>
          <label className="block text-sm font-medium" htmlFor="network">
            Network
            <select id="network" value={network} onChange={(event) => setNetwork(event.target.value as AllowedNetwork)} className="mt-2 block w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100">
              {allowedNetworks.map((item) => <option key={item} value={item}>{item === "signet" ? "Signet" : "Regtest"}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium" htmlFor="publicKey">
            Public key
            <input id="publicKey" name="publicKey" value={publicKey} onChange={(event) => setPublicKey(event.target.value)} autoComplete="off" spellCheck="false" placeholder="02… or 03… (33-byte compressed hex)" className="mt-2 block w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100" />
          </label>
          <label className="block text-sm font-medium" htmlFor="unlockHeight">
            Unlock block
            <input id="unlockHeight" name="unlockHeight" inputMode="numeric" value={unlockHeight} onChange={(event) => setUnlockHeight(event.target.value)} autoComplete="off" placeholder="e.g. 840000" className="mt-2 block w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100" />
          </label>
          {error && <p role="alert" className="rounded border border-red-800 bg-red-950/60 p-3 text-sm text-red-200">{error}</p>}
          <button type="submit" className="rounded bg-amber-400 px-5 py-2.5 text-sm font-bold text-zinc-950 hover:bg-amber-300">Criar cofre</button>
        </form>
      </section>

      {bundle && <section aria-live="polite" className="mt-8 rounded-xl border border-emerald-800/70 bg-emerald-950/20 p-5 sm:p-7">
        <p className="text-xs font-bold tracking-[0.15em] text-emerald-300">COFRE DE TESTE</p>
        <h2 className="mt-2 text-2xl font-semibold">Locked by policy</h2>
        <dl className="mt-6 space-y-5 text-sm">
          <Field label="Network" value={bundle.network === "signet" ? "Signet" : "Regtest"} />
          <Field label="Address" value={bundle.address} />
          <Field label="Unlock block" value={String(bundle.unlockHeight)} />
          <Field label="Public key" value={bundle.publicKey} />
          <Field label="Witness script" value={bundle.witnessScript} />
          <Field label="Output script (P2WSH v0)" value={bundle.outputScript} />
        </dl>
        <div className="mt-7 border-t border-emerald-900 pt-5">
          <h3 className="font-semibold">Recovery bundle</h3>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" onClick={() => setShowBundle((value) => !value)} className="rounded border border-zinc-600 px-3 py-2 text-sm hover:bg-zinc-800">visualizar</button>
            <button type="button" onClick={copyBundle} className="rounded border border-zinc-600 px-3 py-2 text-sm hover:bg-zinc-800">copiar</button>
            <button type="button" onClick={() => downloadBundle(bundle)} className="rounded border border-zinc-600 px-3 py-2 text-sm hover:bg-zinc-800">baixar</button>
          </div>
          {showBundle && <pre data-testid="recovery-bundle" className="mt-4 overflow-x-auto rounded bg-zinc-950 p-4 text-xs leading-5 text-zinc-300">{JSON.stringify(bundle, null, 2)}</pre>}
        </div>
      </section>}

      <aside className="mt-8 rounded border border-zinc-800 bg-zinc-900/40 p-5 text-sm leading-6 text-zinc-300">
        <p>{securityWarning}</p>
        <p className="mt-3">TimeSats does not possess your private key. The Bitcoin network enforces the timelock. TimeSats cannot unlock this vault early.</p>
        <p className="mt-3">Funds sent to a hard timelock can be impossible to spend before the deadline. Losing your key means losing access. TimeSats offers no recovery.</p>
      </aside>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><dt className="mb-1 font-medium text-zinc-400">{label}</dt><dd className="break-all font-mono text-zinc-100">{value}</dd></div>;
}
