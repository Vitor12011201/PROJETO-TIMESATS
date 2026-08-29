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
import type { CreateVaultPlanInput, DerivedDeposit, VaultPlan } from "@/bitcoin";
import {
  archivePlanIdentity,
  hideDepositIndex,
  loadArchivedPlanIdentities,
  loadHiddenDepositIndexes,
  loadVaultPlans,
  removeHiddenDepositIndexesForPlan,
  restoreHiddenDepositIndex,
  restorePlanIdentity,
  saveArchivedPlanIdentities,
  saveHiddenDepositIndexes,
  saveVaultPlans,
  type HiddenDepositIndexes,
  upsertVaultPlan,
} from "@/storage/vault-plan-storage";
import {
  ActivePlanCard,
  ArchivePlanDialog,
  CreatePlanDialog,
  Footer,
  Header,
  Hero,
  HideDepositDialog,
  HowItWorks,
  NewDepositDialog,
  PlansGrid,
  PrepareSpendDialog,
  RemovePlanDialog,
} from "./timesats-sections";
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

function firstVisiblePlan(plans: VaultPlan[], archivedIdentities: string[]): VaultPlan | null {
  return plans.find((plan) => !archivedIdentities.includes(vaultPlanIdentity(plan))) ?? null;
}

function reconcileActivePlan(plans: VaultPlan[], archivedIdentities: string[], current: VaultPlan | null): VaultPlan | null {
  if (current) {
    const identity = vaultPlanIdentity(current);
    const matching = plans.find((plan) => vaultPlanIdentity(plan) === identity);
    if (matching && !archivedIdentities.includes(identity)) return matching;
  }
  return firstVisiblePlan(plans, archivedIdentities);
}

export function TimeSatsApp() {
  const [plans, setPlans] = useState<VaultPlan[]>([]);
  const [archivedPlanIdentities, setArchivedPlanIdentities] = useState<string[]>([]);
  const [hiddenDepositIndexes, setHiddenDepositIndexes] = useState<HiddenDepositIndexes>({});
  const [activePlan, setActivePlan] = useState<VaultPlan | null>(null);
  const [isCreateOpen, setCreateOpen] = useState(false);
  const [spendDepositIndex, setSpendDepositIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [archiveCandidate, setArchiveCandidate] = useState<VaultPlan | null>(null);
  const [removeCandidate, setRemoveCandidate] = useState<VaultPlan | null>(null);
  const [newDepositCandidate, setNewDepositCandidate] = useState<VaultPlan | null>(null);
  const [hideDepositCandidate, setHideDepositCandidate] = useState<{ plan: VaultPlan; deposit: DerivedDeposit } | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const issueInProgress = useRef(false);
  const deposits = useMemo(() => (activePlan ? deriveIssuedDeposits(activePlan) : []), [activePlan]);

  useEffect(() => {
    const loaded = loadVaultPlans(window.localStorage);
    const archived = loadArchivedPlanIdentities(window.localStorage);
    const hidden = loadHiddenDepositIndexes(window.localStorage);
    setPlans(loaded.plans);
    setArchivedPlanIdentities(archived);
    setHiddenDepositIndexes(hidden);
    setActivePlan(firstVisiblePlan(loaded.plans, archived));
    setStorageError(loaded.error);
  }, []);

  function persist(nextPlans: VaultPlan[]): void {
    saveVaultPlans(window.localStorage, nextPlans);
    setPlans(nextPlans);
  }

  function persistArchived(nextArchivedIdentities: string[]): void {
    saveArchivedPlanIdentities(window.localStorage, nextArchivedIdentities);
    setArchivedPlanIdentities(nextArchivedIdentities);
  }

  function persistHiddenDeposits(nextHiddenDepositIndexes: HiddenDepositIndexes): void {
    saveHiddenDepositIndexes(window.localStorage, nextHiddenDepositIndexes);
    setHiddenDepositIndexes(nextHiddenDepositIndexes);
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
    const reconciled = upsertAndPersist(plan);
    setActivePlan(archivedPlanIdentities.includes(vaultPlanIdentity(reconciled)) ? firstVisiblePlan(plans, archivedPlanIdentities) : reconciled);
    setCreateOpen(false);
    setError(null);
    setStorageError(null);
  }

  function requestNewDeposit(): void {
    if (!activePlan) return;
    issueInProgress.current = false;
    setNewDepositCandidate(activePlan);
  }

  function addSats(): void {
    if (!newDepositCandidate || issueInProgress.current) return;
    issueInProgress.current = true;
    try {
      const { plan } = issueNextDeposit(newDepositCandidate);
      setActivePlan(upsertAndPersist(plan));
      setNewDepositCandidate(null);
      setError(null);
    } catch (cause) {
      issueInProgress.current = false;
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
      const reconciled = upsertAndPersist(imported);
      setActivePlan(archivedPlanIdentities.includes(vaultPlanIdentity(reconciled)) ? reconcileActivePlan(plans, archivedPlanIdentities, activePlan) : reconciled);
      setError(null);
      setStorageError(null);
    } catch (cause) {
      setError(cause instanceof Error ? `Não foi possível importar o bundle: ${cause.message}` : "Não foi possível importar o bundle.");
    } finally {
      event.target.value = "";
    }
  }

  function exportBundle(plan: VaultPlan): void {
    downloadJson(createVaultPlanRecoveryBundle(plan), `timesats-plan-${plan.policy.network}-${plan.policy.unlockHeight}.json`);
  }

  function archivePlan(plan: VaultPlan): void {
    const identity = vaultPlanIdentity(plan);
    const nextArchived = archivePlanIdentity(archivedPlanIdentities, identity);
    persistArchived(nextArchived);
    setActivePlan((current) => reconcileActivePlan(plans, nextArchived, current));
    if (activePlan && vaultPlanIdentity(activePlan) === identity) setSpendDepositIndex(null);
    setArchiveCandidate(null);
  }

  function restorePlan(plan: VaultPlan): void {
    const nextArchived = restorePlanIdentity(archivedPlanIdentities, vaultPlanIdentity(plan));
    persistArchived(nextArchived);
    setActivePlan((current) => reconcileActivePlan(plans, nextArchived, current));
  }

  function hideDeposit(plan: VaultPlan, deposit: DerivedDeposit): void {
    const nextHidden = hideDepositIndex(hiddenDepositIndexes, vaultPlanIdentity(plan), deposit.index);
    persistHiddenDeposits(nextHidden);
    setHideDepositCandidate(null);
  }

  function restoreDeposit(plan: VaultPlan, depositIndex: number): void {
    const nextHidden = restoreHiddenDepositIndex(hiddenDepositIndexes, vaultPlanIdentity(plan), depositIndex);
    persistHiddenDeposits(nextHidden);
  }

  function removePlan(plan: VaultPlan): void {
    const identity = vaultPlanIdentity(plan);
    const nextPlans = plans.filter((candidate) => vaultPlanIdentity(candidate) !== identity);
    const nextArchived = restorePlanIdentity(archivedPlanIdentities, identity);
    const nextHidden = removeHiddenDepositIndexesForPlan(hiddenDepositIndexes, identity);
    saveVaultPlans(window.localStorage, nextPlans);
    saveArchivedPlanIdentities(window.localStorage, nextArchived);
    saveHiddenDepositIndexes(window.localStorage, nextHidden);
    setPlans(nextPlans);
    setArchivedPlanIdentities(nextArchived);
    setHiddenDepositIndexes(nextHidden);
    setActivePlan((current) => reconcileActivePlan(nextPlans, nextArchived, current));
    if (activePlan && vaultPlanIdentity(activePlan) === identity) setSpendDepositIndex(null);
    if (newDepositCandidate && vaultPlanIdentity(newDepositCandidate) === identity) setNewDepositCandidate(null);
    if (hideDepositCandidate && vaultPlanIdentity(hideDepositCandidate.plan) === identity) setHideDepositCandidate(null);
    setRemoveCandidate(null);
  }

  return (
    <div className={styles.application}>
      <Header onCreate={() => setCreateOpen(true)} />
      <main className={styles.main}>
        <section className={styles.hero} id="produto">
          <Hero onCreate={() => setCreateOpen(true)} />
          <ActivePlanCard activePlan={activePlan} deposits={deposits} hiddenDepositIndexes={activePlan ? hiddenDepositIndexes[vaultPlanIdentity(activePlan)] ?? [] : []} onAdd={requestNewDeposit} onCopy={copyAddress} onCreate={() => setCreateOpen(true)} onExport={() => activePlan && exportBundle(activePlan)} onPrepareSpend={setSpendDepositIndex} onHideDeposit={(deposit) => activePlan && setHideDepositCandidate({ plan: activePlan, deposit })} onRestoreDeposit={(depositIndex) => activePlan && restoreDeposit(activePlan, depositIndex)} />
        </section>
        <HowItWorks />
        <PlansGrid activePlan={activePlan} plans={plans} archivedPlanIdentities={archivedPlanIdentities} onCreate={() => setCreateOpen(true)} onSelect={(plan) => { setActivePlan(plan); setError(null); }} onImport={() => importInput.current?.click()} onExport={exportBundle} onArchive={setArchiveCandidate} onRestore={restorePlan} onRemove={setRemoveCandidate} />
        {storageError && <p className={styles.alert} role="alert">{storageError}</p>}
        {error && <p className={styles.alert} role="alert">{error}</p>}
      </main>
      <Footer />
      <input ref={importInput} className={styles.visuallyHidden} type="file" accept="application/json,.json" onChange={importBundle} aria-label="Importar recovery bundle" />
      {isCreateOpen && <CreatePlanDialog onClose={() => setCreateOpen(false)} onCreate={createPlan} />}
      {activePlan && spendDepositIndex !== null && <PrepareSpendDialog plan={activePlan} depositIndex={spendDepositIndex} onClose={() => setSpendDepositIndex(null)} />}
      {newDepositCandidate && <NewDepositDialog plan={newDepositCandidate} onClose={() => setNewDepositCandidate(null)} onConfirm={addSats} />}
      {hideDepositCandidate && <HideDepositDialog plan={hideDepositCandidate.plan} deposit={hideDepositCandidate.deposit} onClose={() => setHideDepositCandidate(null)} onConfirm={() => hideDeposit(hideDepositCandidate.plan, hideDepositCandidate.deposit)} />}
      {archiveCandidate && <ArchivePlanDialog plan={archiveCandidate} onClose={() => setArchiveCandidate(null)} onConfirm={() => archivePlan(archiveCandidate)} />}
      {removeCandidate && <RemovePlanDialog plan={removeCandidate} onClose={() => setRemoveCandidate(null)} onExport={() => exportBundle(removeCandidate)} onConfirm={() => removePlan(removeCandidate)} />}
    </div>
  );
}
