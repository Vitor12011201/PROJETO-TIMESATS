import { useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowRight,
  Bitcoin,
  CalendarDays,
  ChevronRight,
  CircleCheck,
  Copy,
  Download,
  Hourglass,
  House,
  KeyRound,
  Landmark,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Target,
  TrendingUp,
  Upload,
  X,
} from "lucide-react";
import type { DerivedDeposit } from "@/bitcoin/vault-plan";
import type { CreateVaultPlanInput, VaultPlan } from "@/domain/vault-plan";
import { allowedNetworks, type AllowedNetwork } from "@/domain/vault-policy";
import styles from "./timesats-ui.module.css";

const githubUrl = "https://github.com/Vitor12011201/PROJETO-TIMESATS";

function shortenedAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-5)}`;
}

export function Header({ onCreate }: { onCreate: () => void }) {
  return (
    <header className={styles.header}>
      <div className={styles.navInner}>
        <a className={styles.brand} href="#produto" aria-label="TimeSats, início">
          <span className={styles.brandMark}><Hourglass aria-hidden="true" size={22} strokeWidth={1.8} /></span>
          <span>TimeSats</span>
        </a>
        <nav className={styles.navigation} aria-label="Navegação principal">
          <a href="#produto">Produto</a><a href="#como-funciona">Como funciona</a><a href="#seguranca">Segurança</a><a href="#documentacao">Documentação</a><a href={githubUrl} target="_blank" rel="noreferrer">GitHub</a>
        </nav>
        <button type="button" className={styles.outlineButton} onClick={onCreate}>Criar meu plano</button>
      </div>
    </header>
  );
}

export function Hero({ onCreate }: { onCreate: () => void }) {
  return (
    <div className={styles.heroCopy}>
      <div className={styles.mountainScene} aria-hidden="true">
        <span className={styles.sun} />
        <svg viewBox="0 0 760 205" preserveAspectRatio="none"><path d="M0 183 78 161l51-47 55 48 63-39 68 32 87-75 43 44 47-30 52 57 81-72 56 51 49-25v80H0Z" /><path className={styles.mountainFar} d="m0 198 111-43 76 24 82-67 78 66 77-40 73 31 73-51 69 48 70-29 61 31v31H0Z" /></svg>
      </div>
      <p className={styles.eyebrow}>TIMESATS · V0.2</p>
      <h1>Seu Bitcoin.<br />Seu prazo.<br /><span>Suas chaves.</span></h1>
      <p className={styles.heroDescription}>Compromissos de longo prazo protegidos pela própria rede Bitcoin. Sem custódia. Sem confiança. Só código.</p>
      <div className={styles.heroActions}>
        <button type="button" className={styles.primaryButton} onClick={onCreate}>Criar meu plano <ChevronRight aria-hidden="true" size={18} /></button>
        <a className={styles.secondaryButton} href="#como-funciona">Entender como funciona <ChevronRight aria-hidden="true" size={18} /></a>
      </div>
      <div className={styles.trustFeatures}>
        <TrustFeature icon={<KeyRound />} title={<>Você mantém<br />as chaves</>} text="Autocustódia total." />
        <TrustFeature icon={<LockKeyhole />} title={<>Sem seed<br />na TimeSats</>} text="Nunca vemos suas chaves." />
        <TrustFeature icon={<Bitcoin />} title={<>Bitcoin aplica<br />a regra</>} text="O tempo é imposto pela rede." />
      </div>
    </div>
  );
}

function TrustFeature({ icon, title, text }: { icon: ReactNode; title: ReactNode; text: string }) {
  return <div className={styles.trustFeature}><span className={styles.trustIcon}>{icon}</span><div><strong>{title}</strong><p>{text}</p></div></div>;
}

interface ActivePlanCardProps {
  activePlan: VaultPlan | null;
  deposits: DerivedDeposit[];
  onAdd: () => void;
  onCopy: (address: string) => Promise<void>;
  onCreate: () => void;
  onExport: () => void;
}

export function ActivePlanCard({ activePlan, deposits, onAdd, onCopy, onCreate, onExport }: ActivePlanCardProps) {
  if (!activePlan) {
    return <aside className={`${styles.activePlanCard} ${styles.emptyActiveCard}`} aria-label="Nenhum plano ativo"><p className={styles.eyebrow}>PLANO LOCAL</p><h2>Nenhum plano ativo</h2><p>Crie seu primeiro compromisso para emitir endereços P2WSH protegidos por um mesmo prazo.</p><button type="button" className={styles.primaryButton} onClick={onCreate}>Criar meu plano <ArrowRight aria-hidden="true" size={18} /></button><div className={styles.cardSafety}><LockKeyhole aria-hidden="true" size={17} /> Signet / Regtest apenas. Não envie Bitcoin real.</div></aside>;
  }
  const nextIndex = activePlan.lastIssuedIndex + 1;
  return (
    <aside className={styles.activePlanCard} aria-label={`Plano ativo ${activePlan.metadata.label}`}>
      <div className={styles.planTopline}><p className={styles.eyebrow}>PLANO LOCAL</p><span className={styles.localBadge}><span /> LOCAL</span></div>
      <h2>{activePlan.metadata.label}</h2>
      <p className={styles.commitment}><LockKeyhole aria-hidden="true" size={20} /> Bloqueado até o bloco {activePlan.policy.unlockHeight}</p>
      <div className={styles.metrics}><Metric label="Endereços emitidos" value={String(deposits.length)} /><Metric label="Próximo índice" value={`#${nextIndex}`} /></div>
      <div className={styles.depositTitle}>DEPÓSITOS</div>
      <div className={styles.depositList}>{deposits.map((deposit) => <DepositRow key={deposit.index} deposit={deposit} onCopy={onCopy} />)}</div>
      <div className={styles.planActions}><button type="button" className={styles.addButton} onClick={onAdd}>Adicionar sats a este plano <Plus aria-hidden="true" size={19} /></button><button type="button" className={styles.recoveryButton} onClick={onExport}><Download aria-hidden="true" size={15} /> Recovery</button></div>
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function DepositRow({ deposit, onCopy }: { deposit: DerivedDeposit; onCopy: (address: string) => Promise<void> }) {
  return <article className={styles.depositRow}>
    <span className={styles.depositIcon}><CircleCheck aria-hidden="true" size={18} /></span>
    <div className={styles.depositInfo}><strong>Depósito #{deposit.index}</strong><span>Endereço de depósito</span><code title={deposit.address}>{shortenedAddress(deposit.address)}</code></div>
    <button className={styles.copyButton} type="button" onClick={() => onCopy(deposit.address)} aria-label={`Copiar endereço do depósito ${deposit.index}`}><Copy aria-hidden="true" size={15} /></button>
    <div className={styles.depositState}><strong>Índice #{deposit.index}</strong><span>Pronto para depósito</span></div>
    <ChevronRight className={styles.rowChevron} aria-hidden="true" size={18} />
  </article>;
}

export function HowItWorks() {
  const steps = [
    [<Target key="target" />, "1. Escolha um objetivo", "Casa, aposentadoria, reserva de longo prazo. Você decide."],
    [<CalendarDays key="calendar" />, "2. Defina o prazo", "Determine até quando quer manter seu compromisso."],
    [<ShieldCheck key="shield" />, "3. Gere seu plano", "A TimeSats cria os endereços protegidos pela mesma regra."],
    [<TrendingUp key="trend" />, "4. Continue acumulando", "Adicione quantos depósitos quiser. Mesmo plano, mesma proteção."],
  ];
  return <section className={styles.howItWorks} id="como-funciona" aria-labelledby="how-heading"><h2 id="how-heading" className={styles.visuallyHidden}>Como funciona</h2>{steps.map(([icon, title, text]) => <article key={title as string}><span>{icon}</span><div><h3>{title}</h3><p>{text}</p></div></article>)}</section>;
}

interface PlansGridProps { activePlan: VaultPlan | null; plans: VaultPlan[]; onCreate: () => void; onSelect: (plan: VaultPlan) => void; onImport: () => void; }

export function PlansGrid({ activePlan, plans, onCreate, onSelect, onImport }: PlansGridProps) {
  return <section className={styles.plansSection} aria-labelledby="plans-heading">
    <div className={styles.sectionHeader}><div><h2 id="plans-heading">Meus planos</h2><p>Visão geral dos seus compromissos de longo prazo.</p></div><div className={styles.sectionActions}><button type="button" className={styles.subtleButton} onClick={onImport}><Upload aria-hidden="true" size={15} /> Importar</button><button type="button" className={styles.outlineButton} onClick={onCreate}><Plus aria-hidden="true" size={17} /> Novo plano</button></div></div>
    {plans.length === 0 ? <div className={styles.emptyPlans}><p>Nenhum plano criado ainda.</p><span>Crie seu primeiro compromisso de longo prazo.</span><button type="button" className={styles.primaryButton} onClick={onCreate}>Criar meu plano <ChevronRight aria-hidden="true" size={18} /></button></div> : <div className={styles.plansGrid}>{plans.map((plan, index) => <PlanCard key={plan.policy.keySource.extendedPublicKey + plan.policy.unlockHeight} plan={plan} active={activePlan?.policy.keySource.extendedPublicKey === plan.policy.keySource.extendedPublicKey && activePlan.policy.unlockHeight === plan.policy.unlockHeight} onSelect={() => onSelect(plan)} index={index} />)}<button type="button" className={styles.newPlanCard} onClick={onCreate}><span><Plus aria-hidden="true" size={29} /></span><div><strong>Criar novo plano</strong><p>Comece um novo compromisso de longo prazo.</p></div></button></div>}
  </section>;
}

function PlanCard({ plan, active, onSelect, index }: { plan: VaultPlan; active: boolean; onSelect: () => void; index: number }) {
  const Icon = index % 2 === 0 ? House : Landmark;
  return <button type="button" className={`${styles.planCard} ${active ? styles.planCardActive : ""}`} onClick={onSelect}>
    <span className={styles.planIcon}><Icon aria-hidden="true" size={28} /></span><div className={styles.planCardBody}><strong>{plan.metadata.label}</strong><span><LockKeyhole aria-hidden="true" size={13} /> Bloco {plan.policy.unlockHeight}</span><small>{plan.lastIssuedIndex + 1} {plan.lastIssuedIndex === 0 ? "endereço emitido" : "endereços emitidos"}</small></div><div className={styles.planIndex}><span>Próximo índice</span><strong>#{plan.lastIssuedIndex + 1}</strong></div><ChevronRight aria-hidden="true" size={18} /></button>;
}

export function Footer() {
  return <footer className={styles.footer} id="seguranca"><div><strong>TimeSats © 2026</strong><span>Experimental software. Signet / Regtest only. Do not send real bitcoin.</span></div><nav id="documentacao" aria-label="Links de rodapé"><a href="#seguranca">Segurança</a><a href="#produto">Recovery</a><a href="docs/vault-plans.md">Documentação</a><a href={githubUrl} target="_blank" rel="noreferrer">GitHub</a><a href={githubUrl} aria-label="GitHub do TimeSats" target="_blank" rel="noreferrer"><GithubMark /></a></nav></footer>;
}

function GithubMark() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.58 2 12.23c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.49 0-.24-.01-1.05-.01-1.91-2.78.62-3.37-1.2-3.37-1.2-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.86.09-.67.35-1.12.64-1.38-2.22-.26-4.56-1.14-4.56-5.08 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.31.1-2.73 0 0 .84-.28 2.75 1.05A9.32 9.32 0 0 1 12 7.14a9.3 9.3 0 0 1 2.5.35c1.91-1.33 2.75-1.05 2.75-1.05.55 1.42.2 2.47.1 2.73.64.72 1.03 1.63 1.03 2.75 0 3.95-2.35 4.81-4.58 5.07.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.22 10.22 0 0 0 22 12.23C22 6.58 17.52 2 12 2Z" /></svg>;
}

export function CreatePlanDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (input: CreateVaultPlanInput) => void }) {
  const [label, setLabel] = useState("");
  const [network, setNetwork] = useState<AllowedNetwork>("signet");
  const [extendedPublicKey, setExtendedPublicKey] = useState("");
  const [unlockHeight, setUnlockHeight] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    try {
      if (!/^\d+$/.test(unlockHeight)) throw new Error("O bloco de desbloqueio deve ser uma altura inteira.");
      onCreate({ label, network, extendedPublicKey: extendedPublicKey.trim(), unlockHeight: Number(unlockHeight) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível criar o plano."); }
  }
  return <div className={styles.dialogBackdrop} role="presentation"><section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="create-plan-title"><button type="button" className={styles.closeButton} onClick={onClose} aria-label="Fechar criação de plano"><X aria-hidden="true" size={19} /></button><p className={styles.eyebrow}>NOVO PLANO</p><h2 id="create-plan-title">Crie seu compromisso</h2><p>Informe apenas uma chave pública estendida de teste. Nunca informe seed ou chave privada.</p><form onSubmit={submit} noValidate><label htmlFor="label">Nome do plano<input id="label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Minha Casa" autoComplete="off" /></label><label htmlFor="network">Rede<select id="network" value={network} onChange={(event) => setNetwork(event.target.value as AllowedNetwork)}>{allowedNetworks.map((item) => <option key={item} value={item}>{item === "signet" ? "Signet" : "Regtest"}</option>)}</select></label><label htmlFor="extendedPublicKey">Chave pública estendida (tpub)<input id="extendedPublicKey" value={extendedPublicKey} onChange={(event) => setExtendedPublicKey(event.target.value)} placeholder="tpub…" autoComplete="off" spellCheck="false" /></label><label htmlFor="unlockHeight">Bloco de desbloqueio<input id="unlockHeight" value={unlockHeight} onChange={(event) => setUnlockHeight(event.target.value)} placeholder="840000" inputMode="numeric" autoComplete="off" /></label>{error && <p role="alert" className={styles.dialogError}>{error}</p>}<div className={styles.dialogNotice}>EXPERIMENTAL · SIGNET / REGTEST ONLY · DO NOT SEND REAL BITCOIN</div><button type="submit" className={styles.primaryButton}>Criar plano <ArrowRight aria-hidden="true" size={18} /></button></form></section></div>;
}
