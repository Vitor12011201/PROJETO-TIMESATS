"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createVaultPlan,
  createVaultPlanRecoveryBundle,
  deriveIssuedDeposits,
  issueNextDeposit,
  reconstructVaultPlan,
  vaultPlanIdentity,
} from "@/bitcoin";
import type { CreateVaultPlanInput, VaultPlan } from "@/bitcoin";
import { loadVaultPlans, saveVaultPlans, upsertVaultPlan } from "@/storage/vault-plan-storage";
import { ActivePlanCard, CreatePlanDialog, Footer, Header, Hero, HowItWorks, PlansGrid, PrepareSpendDialog } from "./timesats-sections";
import styles from "./timesats-ui.module.css";

function downloadJson(value: object, fileName: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function TimeSatsApp() {
  const [plans, setPlans] = useState<VaultPlan[]>([]);
  const [activePlan, setActivePlan] = useState<VaultPlan | null>(null);
  const [isCreateOpen, setCreateOpen] = useState(false);
  const [spendDepositIndex, setSpendDepositIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const deposits = useMemo(() => (activePlan ? deriveIssuedDeposits(activePlan) : []), [activePlan]);

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

  function upsertAndPersist(plan: VaultPlan): VaultPlan {
    const nextPlans = upsertVaultPlan(plans, plan);
    const reconciled = nextPlans.find((candidate) => vaultPlanIdentity(candidate) === vaultPlanIdentity(plan));
    if (!reconciled) throw new Error("Could not reconcile the VaultPlan being saved.");
    persist(nextPlans);
    return reconciled;
  }

  function createPlan(input: CreateVaultPlanInput): void {
    const plan = createVaultPlan(input);
    setActivePlan(upsertAndPersist(plan));
    setCreateOpen(false);
    setError(null);
    setStorageError(null);
  }

  function addSats(): void {
    if (!activePlan) return;
    try {
      const { plan } = issueNextDeposit(activePlan);
      setActivePlan(upsertAndPersist(plan));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível gerar o próximo endereço de depósito.");
    }
  }

  async function copyAddress(address: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(address);
      setError(null);
    } catch {
      setError("Não foi possível copiar o endereço. Selecione o valor e copie manualmente.");
    }
  }

  async function importBundle(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = reconstructVaultPlan(JSON.parse(await file.text()));
      setActivePlan(upsertAndPersist(imported));
      setError(null);
      setStorageError(null);
    } catch (cause) {
      setError(cause instanceof Error ? `Não foi possível importar o bundle: ${cause.message}` : "Não foi possível importar o bundle.");
    } finally {
      event.target.value = "";
    }
  }

  function exportBundle(): void {
    if (!activePlan) return;
    downloadJson(createVaultPlanRecoveryBundle(activePlan), `timesats-plan-${activePlan.policy.network}-${activePlan.policy.unlockHeight}.json`);
  }

  return (
    <div className={styles.application}>
      <Header onCreate={() => setCreateOpen(true)} />
      <main className={styles.main}>
        <section className={styles.hero} id="produto">
          <Hero onCreate={() => setCreateOpen(true)} />
          <ActivePlanCard activePlan={activePlan} deposits={deposits} onAdd={addSats} onCopy={copyAddress} onCreate={() => setCreateOpen(true)} onExport={exportBundle} onPrepareSpend={setSpendDepositIndex} />
        </section>
        <HowItWorks />
        <PlansGrid activePlan={activePlan} plans={plans} onCreate={() => setCreateOpen(true)} onSelect={(plan) => { setActivePlan(plan); setError(null); }} onImport={() => importInput.current?.click()} />
        {storageError && <p className={styles.alert} role="alert">{storageError}</p>}
        {error && <p className={styles.alert} role="alert">{error}</p>}
      </main>
      <Footer />
      <input ref={importInput} className={styles.visuallyHidden} type="file" accept="application/json,.json" onChange={importBundle} aria-label="Importar recovery bundle" />
      {isCreateOpen && <CreatePlanDialog onClose={() => setCreateOpen(false)} onCreate={createPlan} />}
      {activePlan && spendDepositIndex !== null && <PrepareSpendDialog plan={activePlan} depositIndex={spendDepositIndex} onClose={() => setSpendDepositIndex(null)} />}
    </div>
  );
}
