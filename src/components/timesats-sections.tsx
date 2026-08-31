import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Archive,
  Bitcoin,
  CalendarDays,
  ChevronRight,
  CircleCheck,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileKey,
  FileUp,
  House,
  KeyRound,
  Landmark,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  Send,
  ShieldCheck,
  Target,
  TrendingUp,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  allowedNetworks,
  buildUnsignedVaultPsbt,
  createVaultSpendIntent,
  finalizeVaultPsbt,
  validateSignedVaultPsbt,
  verifyFundingTransaction,
  vaultPlanIdentity,
} from "@/bitcoin";
import type {
  AllowedNetwork,
  CreateVaultPlanInput,
  DerivedDeposit,
  VaultPlan,
  VaultSpendIntent,
  VaultUtxo,
} from "@/bitcoin";
import { decodePsbtFile, psbtBase64ToBytes } from "./psbt-file";
import styles from "./timesats-ui.module.css";

const githubUrl = "https://github.com/Vitor12011201/PROJETO-TIMESATS";

function shortenedAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-5)}`;
}

export function Header({ onCreate }: { onCreate: () => void }) {
  return (
    <header className={styles.header}>
      <div className={styles.navInner}>
        <Link className={styles.brand} href="/" aria-label="TimeSats, página inicial">
          <Image className={styles.brandLogo} src="/brand/timesats-logo.png" alt="TimeSats" width={60} height={60} priority unoptimized sizes="(max-width: 620px) 52px, 60px" />
        </Link>
        <nav className={styles.navigation} aria-label="Navegação principal">
          <a href="#produto">Produto</a><a href="#como-funciona">Como funciona</a><a href="#seguranca">Segurança</a><a href="#documentacao">Documentação</a><a href={githubUrl} target="_blank" rel="noreferrer">GitHub</a>
        </nav>
        <button type="button" className={styles.headerCta} onClick={onCreate}>Criar meu plano <Plus aria-hidden="true" size={17} /></button>
      </div>
    </header>
  );
}

export function Hero({ onCreate }: { onCreate: () => void }) {
  return (
    <div className={styles.heroCopy}>
      <p className={styles.networkNotice}><span aria-hidden="true" /> Signet / Regtest only</p>
      <h1>Seu Bitcoin.<br />Seu prazo.<br /><span>Suas chaves.</span></h1>
      <p className={styles.heroDescription}>Compromissos de longo prazo protegidos pela própria rede Bitcoin. Sem custódia. Sem confiança. Só código.</p>
      <div className={styles.heroActions}>
        <button type="button" className={styles.primaryButton} onClick={onCreate}>Criar meu plano <ChevronRight aria-hidden="true" size={18} /></button>
        <a className={styles.secondaryButton} href="#como-funciona">Entender como funciona <ChevronRight aria-hidden="true" size={18} /></a>
      </div>
      <div className={styles.trustFeatures}>
        <TrustFeature icon={<KeyRound />} title="Você mantém as chaves" text="Autocustódia total." />
        <TrustFeature icon={<LockKeyhole />} title="Sem seed na TimeSats" text="Nunca vemos suas chaves." />
        <TrustFeature icon={<Bitcoin />} title="Bitcoin aplica a regra" text="O prazo é imposto pela rede." />
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
  hiddenDepositIndexes: number[];
  onAdd: () => void;
  onCopy: (address: string) => Promise<void>;
  onCreate: () => void;
  onExport: () => void;
  onPrepareSpend: (depositIndex: number) => void;
  onHideDeposit: (deposit: DerivedDeposit) => void;
  onRestoreDeposit: (depositIndex: number) => void;
}

export function ActivePlanCard({ activePlan, deposits, hiddenDepositIndexes, onAdd, onCopy, onCreate, onExport, onPrepareSpend, onHideDeposit, onRestoreDeposit }: ActivePlanCardProps) {
  const [showHiddenDeposits, setShowHiddenDeposits] = useState(false);
  const [openDepositOptions, setOpenDepositOptions] = useState<number | null>(null);
  if (!activePlan) {
    return <aside className={`${styles.activePlanCard} ${styles.emptyActiveCard}`} aria-label="Nenhum plano ativo"><p className={styles.eyebrow}>PLANO LOCAL</p><h2>Nenhum plano ativo</h2><p>Crie seu primeiro compromisso para emitir endereços P2WSH protegidos por um mesmo prazo.</p><button type="button" className={styles.primaryButton} onClick={onCreate}>Criar meu plano <ArrowRight aria-hidden="true" size={18} /></button><div className={styles.cardSafety}><LockKeyhole aria-hidden="true" size={17} /> Signet / Regtest apenas. Não envie Bitcoin real.</div></aside>;
  }
  const nextIndex = activePlan.lastIssuedIndex + 1;
  const hiddenIndexes = new Set(hiddenDepositIndexes.filter((index) => index >= 0 && index <= activePlan.lastIssuedIndex));
  const visibleDeposits = deposits.filter((deposit) => !hiddenIndexes.has(deposit.index));
  const hiddenDeposits = deposits.filter((deposit) => hiddenIndexes.has(deposit.index));
  return (
    <aside className={styles.activePlanCard} aria-label={`Plano ativo ${activePlan.metadata.label}`}>
      <div className={styles.planTopline}><p className={styles.eyebrow}>PLANO ATIVO</p><span className={styles.localBadge}><span /> {activePlan.policy.network === "regtest" ? "Regtest local" : "Signet"}</span></div>
      <h2>{activePlan.metadata.label}</h2>
      <p className={styles.commitment}><LockKeyhole aria-hidden="true" size={20} /> Bloqueado até o bloco {activePlan.policy.unlockHeight}</p>
      <div className={styles.metrics}><Metric label="Endereços emitidos" value={String(deposits.length)} /><Metric label="Próximo índice" value={`#${nextIndex}`} /></div>
      <div className={styles.depositHeading}><div className={styles.depositTitle}>Depósitos</div>{visibleDeposits.length > 0 && hiddenDeposits.length > 0 && <button type="button" className={styles.hiddenDepositsButton} onClick={() => setShowHiddenDeposits((current) => !current)} aria-expanded={showHiddenDeposits}>{showHiddenDeposits ? "Ocultar ocultos" : `Ver ocultos (${hiddenDeposits.length})`}</button>}</div>
      {visibleDeposits.length > 0 ? <div className={styles.depositList}>{visibleDeposits.map((deposit) => <DepositRow key={deposit.index} deposit={deposit} onCopy={onCopy} onPrepare={() => onPrepareSpend(deposit.index)} onHide={() => onHideDeposit(deposit)} optionsOpen={openDepositOptions === deposit.index} onOptionsOpenChange={(open) => setOpenDepositOptions(open ? deposit.index : null)} />)}</div> : <div className={styles.hiddenDepositsEmpty}><strong>Nenhum endereço visível</strong><p>Este plano possui {deposits.length} endereços emitidos, atualmente ocultos da lista.</p>{hiddenDeposits.length > 0 && <button type="button" className={styles.subtleButton} onClick={() => setShowHiddenDeposits(true)}>Ver ocultos ({hiddenDeposits.length})</button>}</div>}
      {showHiddenDeposits && hiddenDeposits.length > 0 && <section className={styles.hiddenDeposits} aria-labelledby="hidden-deposits-heading"><div className={styles.hiddenDepositsHeader}><div><p className={styles.eyebrow}>OCULTOS</p><h3 id="hidden-deposits-heading">Endereços ocultos</h3></div><button type="button" className={styles.subtleButton} onClick={() => setShowHiddenDeposits(false)}>Ocultar</button></div><div className={styles.hiddenDepositList}>{hiddenDeposits.map((deposit) => <HiddenDepositRow key={deposit.index} deposit={deposit} onCopy={onCopy} onRestore={() => onRestoreDeposit(deposit.index)} />)}</div></section>}
      <div className={styles.planActions}><button type="button" className={styles.addButton} onClick={onAdd}>Adicionar Bitcoin <Plus aria-hidden="true" size={19} /></button><button type="button" className={styles.recoveryButton} onClick={onExport}><Download aria-hidden="true" size={15} /> Recovery</button></div>
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function DepositRow({ deposit, onCopy, onPrepare, onHide, optionsOpen, onOptionsOpenChange }: { deposit: DerivedDeposit; onCopy: (address: string) => Promise<void>; onPrepare: () => void; onHide: () => void; optionsOpen: boolean; onOptionsOpenChange: (open: boolean) => void }) {
  return <article className={styles.depositRow}>
    <span className={styles.depositIcon}><CircleCheck aria-hidden="true" size={18} /></span>
    <div className={styles.depositInfo}><strong>Depósito #{deposit.index}</strong><code title={deposit.address}>{shortenedAddress(deposit.address)}</code></div>
    <button className={styles.copyButton} type="button" onClick={() => onCopy(deposit.address)} aria-label={`Copiar endereço do depósito ${deposit.index}`}><Copy aria-hidden="true" size={15} /></button>
    <div className={styles.depositState}>#{deposit.index}</div>
    <button className={styles.prepareButton} type="button" onClick={onPrepare}>Preparar gasto</button>
    <DepositOptionsMenu deposit={deposit} open={optionsOpen} onOpenChange={onOptionsOpenChange} onHide={onHide} />
  </article>;
}

function DepositOptionsMenu({ deposit, open, onOpenChange, onHide }: { deposit: DerivedDeposit; open: boolean; onOpenChange: (open: boolean) => void; onHide: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function closeWhenClickingOutside(event: PointerEvent): void {
      if (!menuRef.current?.contains(event.target as Node)) onOpenChange(false);
    }
    document.addEventListener("pointerdown", closeWhenClickingOutside);
    return () => document.removeEventListener("pointerdown", closeWhenClickingOutside);
  }, [open, onOpenChange]);
  return <div ref={menuRef} className={styles.depositOptions} onKeyDown={(event) => { if (event.key === "Escape") onOpenChange(false); }}><button type="button" className={styles.depositOptionsButton} aria-label={`Opções do depósito ${deposit.index}`} aria-haspopup="menu" aria-expanded={open} onClick={() => onOpenChange(!open)}><MoreHorizontal aria-hidden="true" size={17} /></button>{open && <div className={styles.depositOptionsMenu} role="menu" aria-label={`Ações para depósito ${deposit.index}`}><button type="button" role="menuitem" onClick={() => { onHide(); onOpenChange(false); }}><EyeOff aria-hidden="true" size={15} /> Ocultar da lista</button></div>}</div>;
}

function HiddenDepositRow({ deposit, onCopy, onRestore }: { deposit: DerivedDeposit; onCopy: (address: string) => Promise<void>; onRestore: () => void }) {
  return <article className={styles.hiddenDepositRow}><div className={styles.depositInfo}><strong>Depósito #{deposit.index}</strong><code title={deposit.address}>{shortenedAddress(deposit.address)}</code></div><div className={styles.hiddenDepositActions}><button className={styles.copyButton} type="button" onClick={() => onCopy(deposit.address)} aria-label={`Copiar endereço do depósito ${deposit.index}`}><Copy aria-hidden="true" size={15} /></button><button type="button" className={styles.subtleButton} onClick={onRestore}><Eye aria-hidden="true" size={15} /> Mostrar novamente</button></div></article>;
}

export function NewDepositDialog({ plan, onClose, onConfirm }: { plan: VaultPlan; onClose: () => void; onConfirm: () => void }) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent): void { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const nextIndex = plan.lastIssuedIndex + 1;
  return <div className={styles.dialogBackdrop} role="presentation"><section className={`${styles.dialog} ${styles.lifecycleDialog}`} role="dialog" aria-modal="true" aria-labelledby="new-deposit-title"><button type="button" className={styles.closeButton} onClick={onClose} aria-label="Fechar geração de endereço"><X aria-hidden="true" size={19} /></button><p className={styles.eyebrow}>RECEBER BITCOIN</p><h2 id="new-deposit-title">Gerar novo endereço?</h2><p>A TimeSats vai gerar um novo endereço protegido pelas mesmas regras deste plano.</p><dl className={styles.depositDialogDetails}><div><dt>Plano</dt><dd>{plan.metadata.label}</dd></div><div><dt>Próximo depósito</dt><dd>#{nextIndex}</dd></div><div><dt>Rede</dt><dd>{plan.policy.network === "regtest" ? "Regtest local" : "Signet"}</dd></div><div><dt>Desbloqueio</dt><dd>Bloco {plan.policy.unlockHeight}</dd></div></dl><p className={styles.dialogNotice}>Depois que um endereço é gerado, seu índice não será reutilizado.</p><div className={styles.lifecycleActions}><button type="button" className={styles.subtleButton} onClick={onClose}>Cancelar</button><button type="button" className={styles.primaryButton} onClick={onConfirm}>Gerar endereço #{nextIndex} <Plus aria-hidden="true" size={16} /></button></div></section></div>;
}

export function HideDepositDialog({ plan, deposit, onClose, onConfirm }: { plan: VaultPlan; deposit: DerivedDeposit; onClose: () => void; onConfirm: () => void }) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent): void { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return <div className={styles.dialogBackdrop} role="presentation"><section className={`${styles.dialog} ${styles.lifecycleDialog}`} role="dialog" aria-modal="true" aria-labelledby="hide-deposit-title"><button type="button" className={styles.closeButton} onClick={onClose} aria-label="Fechar confirmação de ocultação"><X aria-hidden="true" size={19} /></button><p className={styles.eyebrow}>PREFERÊNCIA LOCAL</p><h2 id="hide-deposit-title">Ocultar este endereço?</h2><p className={styles.lifecyclePlanName}>Depósito #{deposit.index} · {plan.metadata.label}</p><code className={styles.hiddenAddress} title={deposit.address}>{shortenedAddress(deposit.address)}</code><p>O endereço deixará de aparecer na lista principal, mas continuará pertencendo a este plano.</p><p className={styles.dialogNotice}>Ele não será apagado e seu índice nunca será reutilizado.</p><div className={styles.lifecycleActions}><button type="button" className={styles.subtleButton} onClick={onClose}>Cancelar</button><button type="button" className={styles.primaryButton} onClick={onConfirm}><EyeOff aria-hidden="true" size={16} /> Ocultar endereço</button></div></section></div>;
}

export function HowItWorks() {
  const steps = [
    [<Target key="target" />, "1. Escolha um objetivo", "Casa, aposentadoria, reserva de longo prazo. Você decide."],
    [<CalendarDays key="calendar" />, "2. Defina o prazo", "Determine até quando quer manter seu compromisso."],
    [<ShieldCheck key="shield" />, "3. Gere seu plano", "A TimeSats cria os endereços protegidos pela mesma regra."],
    [<TrendingUp key="trend" />, "4. Continue acumulando", "Adicione quantos depósitos quiser. Mesmo plano, mesma proteção."],
  ];
  return <section className={styles.howItWorks} id="como-funciona" aria-labelledby="how-heading"><div className={styles.howHeading}><p className={styles.eyebrow}>COMO FUNCIONA</p><h2 id="how-heading">Um plano. Um prazo. Suas chaves.</h2></div><div className={styles.howSteps}>{steps.map(([icon, title, text]) => <article key={title as string}><span>{icon}</span><div><h3>{title}</h3><p>{text}</p></div></article>)}</div></section>;
}

interface PlansGridProps {
  activePlan: VaultPlan | null;
  plans: VaultPlan[];
  archivedPlanIdentities: string[];
  onCreate: () => void;
  onSelect: (plan: VaultPlan) => void;
  onImport: () => void;
  onExport: (plan: VaultPlan) => void;
  onArchive: (plan: VaultPlan) => void;
  onRestore: (plan: VaultPlan) => void;
  onRemove: (plan: VaultPlan) => void;
}

export function PlansGrid({ activePlan, plans, archivedPlanIdentities, onCreate, onSelect, onImport, onExport, onArchive, onRestore, onRemove }: PlansGridProps) {
  const [showArchived, setShowArchived] = useState(false);
  const [openPlanOptions, setOpenPlanOptions] = useState<string | null>(null);
  const archived = plans.filter((plan) => archivedPlanIdentities.includes(vaultPlanIdentity(plan)));
  const visiblePlans = plans.filter((plan) => !archivedPlanIdentities.includes(vaultPlanIdentity(plan)));
  return <section className={styles.plansSection} aria-labelledby="plans-heading">
    <div className={styles.sectionHeader}><div><h2 id="plans-heading">Meus planos</h2><p>Visão geral dos seus compromissos de longo prazo.</p></div><div className={styles.sectionActions}>{archived.length > 0 && <button type="button" className={styles.subtleButton} onClick={() => setShowArchived((current) => !current)} aria-expanded={showArchived}>{showArchived ? "Ocultar arquivados" : `Arquivados (${archived.length})`}</button>}<button type="button" className={styles.subtleButton} onClick={onImport}><Upload aria-hidden="true" size={15} /> Importar</button><button type="button" className={styles.outlineButton} onClick={onCreate}><Plus aria-hidden="true" size={17} /> Novo plano</button></div></div>
    {visiblePlans.length === 0 ? <div className={styles.emptyPlans}><p>{plans.length === 0 ? "Nenhum plano criado ainda." : "Nenhum plano ativo."}</p><span>{plans.length === 0 ? "Crie seu primeiro compromisso de longo prazo." : "Seus planos continuam salvos neste dispositivo, em Arquivados."}</span><div className={styles.emptyPlanActions}><button type="button" className={styles.primaryButton} onClick={onCreate}>Criar meu plano <ChevronRight aria-hidden="true" size={18} /></button>{archived.length > 0 && <button type="button" className={styles.subtleButton} onClick={() => setShowArchived(true)}>Ver arquivados</button>}</div></div> : <div className={styles.plansGrid}>{visiblePlans.map((plan, index) => <PlanCard key={vaultPlanIdentity(plan)} plan={plan} active={activePlan !== null && vaultPlanIdentity(activePlan) === vaultPlanIdentity(plan)} onSelect={() => onSelect(plan)} onExport={() => onExport(plan)} onArchive={() => onArchive(plan)} onRemove={() => onRemove(plan)} optionsOpen={openPlanOptions === vaultPlanIdentity(plan)} onOptionsOpenChange={(open) => setOpenPlanOptions(open ? vaultPlanIdentity(plan) : null)} index={index} />)}<button type="button" className={styles.newPlanCard} onClick={onCreate}><span><Plus aria-hidden="true" size={29} /></span><div><strong>Criar novo plano</strong><p>Comece um novo compromisso de longo prazo.</p></div></button></div>}
    {showArchived && archived.length > 0 && <section className={styles.archivedPlans} aria-labelledby="archived-plans-heading"><div className={styles.archivedHeading}><div><p className={styles.eyebrow}>ARQUIVADOS</p><h3 id="archived-plans-heading">Planos arquivados</h3></div><button type="button" className={styles.subtleButton} onClick={() => setShowArchived(false)}>Ocultar</button></div><div className={styles.archivedGrid}>{archived.map((plan, index) => <PlanCard key={vaultPlanIdentity(plan)} plan={plan} active={false} onExport={() => onExport(plan)} onRestore={() => onRestore(plan)} onRemove={() => onRemove(plan)} optionsOpen={openPlanOptions === vaultPlanIdentity(plan)} onOptionsOpenChange={(open) => setOpenPlanOptions(open ? vaultPlanIdentity(plan) : null)} index={index} archived />)}</div></section>}
  </section>;
}

interface PlanCardProps {
  plan: VaultPlan;
  active: boolean;
  index: number;
  archived?: boolean;
  onSelect?: () => void;
  onExport: () => void;
  onArchive?: () => void;
  onRestore?: () => void;
  onRemove: () => void;
  optionsOpen: boolean;
  onOptionsOpenChange: (open: boolean) => void;
}

function PlanCard({ plan, active, onSelect, onExport, onArchive, onRestore, onRemove, optionsOpen, onOptionsOpenChange, index, archived = false }: PlanCardProps) {
  const Icon = index % 2 === 0 ? House : Landmark;
  const content = <><div className={styles.planCardTop}><span className={styles.planIcon}><Icon aria-hidden="true" size={19} /></span><span className={styles.planNetwork}>{plan.policy.network === "regtest" ? "Regtest local" : "Signet"}</span></div><div className={styles.planCardBody}><strong>{plan.metadata.label}</strong><span><LockKeyhole aria-hidden="true" size={13} /> Desbloqueio · bloco {plan.policy.unlockHeight}</span></div><div className={styles.planCardMetrics}><span><small>Endereços emitidos</small><strong>{plan.lastIssuedIndex + 1}</strong></span><span><small>Próximo índice</small><strong>#{plan.lastIssuedIndex + 1}</strong></span></div><div className={styles.planLock}><LockKeyhole aria-hidden="true" size={14} /> Bloqueado {!archived && <ChevronRight aria-hidden="true" size={16} />}</div></>;
  return <article className={`${styles.planCard} ${active ? styles.planCardActive : ""} ${archived ? styles.archivedPlanCard : ""}`}>{onSelect ? <button type="button" className={styles.planCardSelect} onClick={onSelect} aria-pressed={active}>{content}</button> : <div className={styles.planCardStatic}>{content}</div>}<PlanOptionsMenu plan={plan} archived={archived} open={optionsOpen} onOpenChange={onOptionsOpenChange} onExport={onExport} onArchive={onArchive} onRestore={onRestore} onRemove={onRemove} /></article>;
}

function PlanOptionsMenu({ plan, archived, open, onOpenChange, onExport, onArchive, onRestore, onRemove }: { plan: VaultPlan; archived: boolean; open: boolean; onOpenChange: (open: boolean) => void; onExport: () => void; onArchive?: () => void; onRestore?: () => void; onRemove: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function closeWhenClickingOutside(event: PointerEvent): void {
      if (!menuRef.current?.contains(event.target as Node)) onOpenChange(false);
    }
    document.addEventListener("pointerdown", closeWhenClickingOutside);
    return () => document.removeEventListener("pointerdown", closeWhenClickingOutside);
  }, [open, onOpenChange]);
  function select(action: () => void): void { action(); onOpenChange(false); }
  return <div ref={menuRef} className={styles.planOptions} onKeyDown={(event) => { if (event.key === "Escape") onOpenChange(false); }}><button type="button" className={styles.planOptionsButton} aria-label={`Opções do plano ${plan.metadata.label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => onOpenChange(!open)}><MoreHorizontal aria-hidden="true" size={18} /></button>{open && <div className={styles.planOptionsMenu} role="menu" aria-label={`Ações para ${plan.metadata.label}`}><button type="button" role="menuitem" onClick={() => select(onExport)}><Download aria-hidden="true" size={15} /> Exportar recovery</button>{archived ? <button type="button" role="menuitem" onClick={() => onRestore && select(onRestore)}><RotateCcw aria-hidden="true" size={15} /> Restaurar</button> : <button type="button" role="menuitem" onClick={() => onArchive && select(onArchive)}><Archive aria-hidden="true" size={15} /> Arquivar</button>}<span role="separator" /><button type="button" role="menuitem" className={styles.removeMenuItem} onClick={() => select(onRemove)}><Trash2 aria-hidden="true" size={15} /> Remover deste dispositivo</button></div>}</div>;
}

export function ArchivePlanDialog({ plan, onClose, onConfirm }: { plan: VaultPlan; onClose: () => void; onConfirm: () => void }) {
  return <div className={styles.dialogBackdrop} role="presentation"><section className={`${styles.dialog} ${styles.lifecycleDialog}`} role="dialog" aria-modal="true" aria-labelledby="archive-plan-title"><button type="button" className={styles.closeButton} onClick={onClose} aria-label="Fechar confirmação de arquivamento"><X aria-hidden="true" size={19} /></button><p className={styles.eyebrow}>PREFERÊNCIA LOCAL</p><h2 id="archive-plan-title">Arquivar plano?</h2><p className={styles.lifecyclePlanName}>{plan.metadata.label}</p><p>O plano deixará de aparecer em “Meus planos”, mas continuará salvo neste dispositivo.</p><div className={styles.lifecycleActions}><button type="button" className={styles.subtleButton} onClick={onClose}>Cancelar</button><button type="button" className={styles.primaryButton} onClick={onConfirm}><Archive aria-hidden="true" size={16} /> Arquivar</button></div></section></div>;
}

export function RemovePlanDialog({ plan, onClose, onExport, onConfirm }: { plan: VaultPlan; onClose: () => void; onExport: () => void; onConfirm: () => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  return <div className={styles.dialogBackdrop} role="presentation"><section className={`${styles.dialog} ${styles.lifecycleDialog} ${styles.removeDialog}`} role="dialog" aria-modal="true" aria-labelledby="remove-plan-title"><button type="button" className={styles.closeButton} onClick={onClose} aria-label="Fechar confirmação de remoção"><X aria-hidden="true" size={19} /></button><p className={styles.eyebrow}>DADOS LOCAIS</p><h2 id="remove-plan-title">Remover este plano deste dispositivo?</h2><p className={styles.lifecyclePlanName}>{plan.metadata.label}</p><p>Isso remove apenas os dados públicos locais do TimeSats.</p><p className={styles.removeWarning}>Isso NÃO move, desbloqueia ou gasta Bitcoin.</p><p>Se você precisar deste plano novamente, será necessário restaurá-lo usando um recovery.</p><div className={styles.recoveryBeforeRemoval}><div><strong>Guarde um recovery antes de remover</strong><span>Ele permite reconstruir este plano e seus endereços emitidos.</span></div><button type="button" className={styles.subtleButton} onClick={onExport}><Download aria-hidden="true" size={15} /> Baixar recovery</button></div><label className={styles.removeAcknowledgement}><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> Entendo que precisarei do recovery para restaurar este plano depois.</label><div className={styles.lifecycleActions}><button type="button" className={styles.subtleButton} onClick={onClose}>Cancelar</button><button type="button" className={styles.dangerButton} onClick={onConfirm} disabled={!acknowledged}><Trash2 aria-hidden="true" size={16} /> Remover deste dispositivo</button></div></section></div>;
}

export function Footer() {
  return <footer className={styles.footer} id="seguranca"><div><strong>TimeSats © 2026</strong><span>Experimental software. Signet / Regtest only. Do not send real bitcoin.</span></div><nav id="documentacao" aria-label="Links de rodapé"><a href="#seguranca">Segurança</a><a href="#produto">Recovery</a><a href="docs/vault-plans.md">Documentação</a><a href={githubUrl} target="_blank" rel="noreferrer">GitHub</a><a href={githubUrl} aria-label="GitHub do TimeSats" target="_blank" rel="noreferrer"><GithubMark /></a></nav></footer>;
}

function GithubMark() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.58 2 12.23c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.49 0-.24-.01-1.05-.01-1.91-2.78.62-3.37-1.2-3.37-1.2-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.86.09-.67.35-1.12.64-1.38-2.22-.26-4.56-1.14-4.56-5.08 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.31.1-2.73 0 0 .84-.28 2.75 1.05A9.32 9.32 0 0 1 12 7.14a9.3 9.3 0 0 1 2.5.35c1.91-1.33 2.75-1.05 2.75-1.05.55 1.42.2 2.47.1 2.73.64.72 1.03 1.63 1.03 2.75 0 3.95-2.35 4.81-4.58 5.07.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.22 10.22 0 0 0 22 12.23C22 6.58 17.52 2 12 2Z" /></svg>;
}

interface PrepareSpendDialogProps {
  plan: VaultPlan;
  depositIndex: number;
  onClose: () => void;
}

function downloadText(value: string, fileName: string, type: string): void {
  const blob = new Blob([value], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadBytes(value: Uint8Array, fileName: string, type: string): void {
  const blob = new Blob([value], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

type SpendStepState = "pending" | "active" | "complete";

function compactValue(value: string): string {
  return value.length > 24 ? `${value.slice(0, 11)}…${value.slice(-8)}` : value;
}

function SpendProgress({ states }: { states: SpendStepState[] }) {
  const labels = ["Depósito", "Destino", "Assinatura", "Importar", "Finalizar"];
  return <ol className={styles.spendProgress} aria-label="Progresso do gasto">{labels.map((label, index) => <li key={label} className={styles[`progress${states[index][0].toUpperCase()}${states[index].slice(1)}`]} aria-current={states[index] === "active" ? "step" : undefined}><span>{states[index] === "complete" ? <CircleCheck aria-hidden="true" size={15} /> : index + 1}</span><small>{label}</small></li>)}</ol>;
}

interface SpendSummaryProps {
  plan: VaultPlan;
  depositIndex: number;
  verified: VaultUtxo | null;
  destination: string;
  feeSats: string;
  destinationValue: number | null;
  unsignedBase64: string;
  signedBase64: string;
  finalTransaction: { rawTransaction: string; txid: string } | null;
}

function SpendSummary({ plan, depositIndex, verified, destination, feeSats, destinationValue, unsignedBase64, signedBase64, finalTransaction }: SpendSummaryProps) {
  const status = finalTransaction ? "Transação pronta" : signedBase64 ? "Assinatura importada" : unsignedBase64 ? "Aguardando assinatura" : verified ? "Depósito verificado" : "Aguardando verificação";
  return <aside className={styles.spendAside} aria-label="Resumo do gasto"><div className={styles.spendAsideHeading}><div><p className={styles.eyebrow}>RESUMO DO GASTO</p><h3>Seu gasto</h3></div><span className={finalTransaction ? styles.summaryComplete : unsignedBase64 || verified ? styles.summaryActive : styles.summaryPending}>{status}</span></div><dl className={styles.spendAsideList}><div><dt>Plano</dt><dd>{plan.metadata.label}</dd></div><div><dt>Depósito</dt><dd>#{depositIndex}</dd></div><div><dt>Rede</dt><dd>{plan.policy.network === "regtest" ? "Regtest local" : "Signet"}</dd></div><div><dt>Desbloqueio</dt><dd>Bloco {plan.policy.unlockHeight}</dd></div>{verified && <div><dt>Entrada</dt><dd>{verified.valueSats.toLocaleString("pt-BR")} sats</dd></div>}{destination && <div><dt>Destino</dt><dd title={destination}>{compactValue(destination)}</dd></div>}{verified && <div><dt>Taxa</dt><dd>{/^\d+$/.test(feeSats) ? `${Number(feeSats).toLocaleString("pt-BR")} sats` : "A definir"}</dd></div>}{destinationValue !== null && <div><dt>Saída</dt><dd>{destinationValue.toLocaleString("pt-BR")} sats</dd></div>}</dl><p className={styles.summaryFootnote}>A assinatura e a transmissão acontecem fora do TimeSats.</p></aside>;
}

/** Session-only PSBT workflow. Funding and PSBT data are deliberately never persisted. */
export function PrepareSpendDialog({ plan, depositIndex, onClose }: PrepareSpendDialogProps) {
  const [fundingHex, setFundingHex] = useState("");
  const [vout, setVout] = useState("0");
  const [verified, setVerified] = useState<VaultUtxo | null>(null);
  const [destination, setDestination] = useState("");
  const [feeSats, setFeeSats] = useState("500");
  const [intent, setIntent] = useState<VaultSpendIntent | null>(null);
  const [unsignedBase64, setUnsignedBase64] = useState("");
  const [signedBase64, setSignedBase64] = useState("");
  const [finalTransaction, setFinalTransaction] = useState<{ rawTransaction: string; txid: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedFile = useRef<HTMLInputElement>(null);

  function invalidateSpendArtifacts(): void {
    setIntent(null); setUnsignedBase64(""); setSignedBase64(""); setFinalTransaction(null);
  }

  function invalidateFunding(): void {
    setVerified(null); invalidateSpendArtifacts();
  }

  function verifyUtxo(): void {
    try {
      if (!/^\d+$/.test(vout)) throw new Error("Vout deve ser um inteiro não negativo.");
      const result = verifyFundingTransaction(plan, depositIndex, fundingHex, Number(vout));
      setVerified(result.utxo);
      invalidateSpendArtifacts(); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível verificar o UTXO."); }
  }

  function generatePsbt(): void {
    try {
      if (!verified) throw new Error("Verifique primeiro a transação de funding.");
      if (!/^\d+$/.test(feeSats)) throw new Error("A fee deve ser um número inteiro de sats.");
      const nextIntent = createVaultSpendIntent(verified, destination, Number(feeSats));
      const psbt = buildUnsignedVaultPsbt(nextIntent, verified);
      setIntent(nextIntent); setUnsignedBase64(psbt.base64); setSignedBase64(""); setFinalTransaction(null); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível gerar o PSBT."); }
  }

  function validateSigned(): void {
    try {
      if (!verified || !intent || !unsignedBase64) throw new Error("Gere primeiro o PSBT não assinado.");
      validateSignedVaultPsbt(intent, verified, signedBase64);
      setFinalTransaction(finalizeVaultPsbt(intent, verified, signedBase64));
      setError(null);
    } catch (cause) { setFinalTransaction(null); setError(cause instanceof Error ? cause.message : "O PSBT assinado não pôde ser validado."); }
  }

  async function copy(value: string): Promise<void> {
    try { await navigator.clipboard.writeText(value); setError(null); } catch { setError("Não foi possível copiar. Selecione o conteúdo e copie manualmente."); }
  }

  async function importSignedFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    setSignedBase64("");
    setFinalTransaction(null);
    try { setSignedBase64(decodePsbtFile(new Uint8Array(await file.arrayBuffer()))); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível ler o arquivo PSBT."); }
    finally { event.target.value = ""; }
  }

  const destinationValue = verified && /^\d+$/.test(feeSats) && Number(feeSats) < verified.valueSats ? verified.valueSats - Number(feeSats) : null;
  const progressStates: SpendStepState[] = [verified ? "complete" : "active", unsignedBase64 ? "complete" : verified ? "active" : "pending", unsignedBase64 ? "complete" : verified ? "active" : "pending", signedBase64 ? "complete" : unsignedBase64 ? "active" : "pending", finalTransaction ? "complete" : signedBase64 ? "active" : "pending"];
  return <div className={styles.dialogBackdrop} role="presentation"><section className={`${styles.dialog} ${styles.spendDialog}`} role="dialog" aria-modal="true" aria-labelledby="prepare-spend-title">
    <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Fechar preparação de gasto"><X aria-hidden="true" size={19} /></button>
    <p className={styles.eyebrow}>GASTO OFFLINE · DEPÓSITO #{depositIndex}</p><h2 id="prepare-spend-title">Preparar gasto</h2>
    <p>O TimeSats prepara e verifica a transação. Sua carteira assina fora desta aplicação.</p><p className={styles.spendSafety}>O TimeSats não possui suas chaves e não transmite a transação.</p>
    <div className={styles.spendLayout}>
      <div className={styles.spendFlow}><SpendProgress states={progressStates} />
        <section className={`${styles.spendStep} ${verified ? styles.spendStepReady : styles.spendStepActive}`}><div className={styles.spendStepHeader}><span>1</span><div><h3>Confirmar o depósito</h3><p>Informe a transação que enviou Bitcoin para este endereço.</p></div></div><div className={styles.fundingFields}><label htmlFor="funding-hex">Transação que enviou Bitcoin<span>Cole a transação completa em formato raw hex.</span><textarea id="funding-hex" value={fundingHex} onChange={(event) => { setFundingHex(event.target.value); invalidateFunding(); }} spellCheck="false" autoComplete="off" /></label><label htmlFor="funding-vout">Índice da saída (vout)<span>Normalmente é 0, 1, 2…</span><input id="funding-vout" value={vout} onChange={(event) => { setVout(event.target.value); invalidateFunding(); }} inputMode="numeric" autoComplete="off" /></label></div><button type="button" className={styles.subtleButton} onClick={verifyUtxo}>Verificar depósito</button>
          {verified && <div className={styles.verifiedBox}><strong><CircleCheck aria-hidden="true" size={17} /> Depósito verificado</strong><div className={styles.verifiedDetails}><span><small>Valor</small>{verified.valueSats.toLocaleString("pt-BR")} sats</span><span><small>TXID</small><code title={verified.txid}>{compactValue(verified.txid)}</code></span><span><small>Vout</small>{verified.vout}</span><span><small>Depósito</small>#{depositIndex}</span></div><span>O output corresponde a este depósito.</span><small>Isto confirma que o output existia na transação informada. Não confirma que ele ainda está não gasto.</small></div>}</section>
        <section className={`${styles.spendStep} ${unsignedBase64 ? styles.spendStepReady : verified ? styles.spendStepActive : styles.spendStepPending}`}><div className={styles.spendStepHeader}><span>2</span><div><h3>Definir o destino</h3><p>Escolha para onde o Bitcoin será enviado quando o prazo permitir.</p></div></div><div className={styles.destinationFields}><label htmlFor="destination-address">Endereço de destino<input id="destination-address" value={destination} onChange={(event) => { setDestination(event.target.value); invalidateSpendArtifacts(); }} spellCheck="false" autoComplete="off" placeholder={plan.policy.network === "regtest" ? "bcrt1…" : "tb1…"} /></label><label htmlFor="fee-sats">Taxa de rede (sats)<input id="fee-sats" value={feeSats} onChange={(event) => { setFeeSats(event.target.value); invalidateSpendArtifacts(); }} inputMode="numeric" autoComplete="off" /></label></div>{verified && <div className={styles.spendSummary}><span>Entrada <strong>{verified.valueSats.toLocaleString("pt-BR")} sats</strong></span><span>Saída <strong>{destinationValue === null ? "—" : `${destinationValue.toLocaleString("pt-BR")} sats`}</strong></span><span>Taxa <strong>{feeSats || "—"} sats</strong></span><span>Desbloqueio <strong>bloco {verified.unlockHeight}</strong></span></div>}<div className={styles.technicalLine}>Detalhe técnico: a transação usa sequence <code>0xfffffffe</code>.</div><button type="button" className={styles.primaryButton} onClick={generatePsbt} disabled={!verified}>Gerar arquivo para assinar <FileKey aria-hidden="true" size={17} /></button></section>
        <section className={`${styles.spendStep} ${unsignedBase64 ? styles.spendStepReady : styles.spendStepPending}`}><div className={styles.spendStepHeader}><span>3</span><div><h3>Preparar assinatura</h3><p>O TimeSats cria um arquivo de transação para sua carteira assinar.</p></div></div>{unsignedBase64 ? <div className={styles.signatureReady}><strong><CircleCheck aria-hidden="true" size={17} /> Arquivo pronto para assinatura</strong><p>Leve este arquivo para sua carteira compatível. Assinar antes do prazo não desbloqueia o UTXO.</p><div className={styles.exportButtons}><button type="button" className={styles.primaryButton} onClick={() => downloadBytes(psbtBase64ToBytes(unsignedBase64), `timesats-deposit-${depositIndex}.psbt`, "application/psbt")}><Download aria-hidden="true" size={15} /> Exportar .psbt</button><button type="button" className={styles.subtleButton} onClick={() => copy(unsignedBase64)}><Copy aria-hidden="true" size={15} /> Copiar Base64</button></div><p className={styles.technicalLine}>Detalhe técnico: o arquivo é um PSBT BIP174 e inclui dados públicos da transação.</p></div> : <p className={styles.pendingCopy}>O arquivo aparecerá aqui depois de confirmar o depósito e definir o destino.</p>}</section>
        <section className={`${styles.spendStep} ${signedBase64 ? styles.spendStepReady : unsignedBase64 ? styles.spendStepActive : styles.spendStepPending}`}><div className={styles.spendStepHeader}><span>4</span><div><h3>Importar assinatura</h3><p>Depois de assinar na sua carteira, importe o arquivo assinado aqui.</p></div></div>{unsignedBase64 && <><div className={styles.importActions}><button type="button" className={styles.primaryButton} onClick={() => signedFile.current?.click()}><FileUp aria-hidden="true" size={16} /> Importar arquivo assinado</button><span>ou cole o conteúdo abaixo</span></div><label htmlFor="signed-psbt">PSBT assinado (Base64)<textarea id="signed-psbt" value={signedBase64} onChange={(event) => { setSignedBase64(event.target.value); setFinalTransaction(null); }} spellCheck="false" autoComplete="off" /></label></>}</section>
        <section className={`${styles.spendStep} ${finalTransaction ? styles.spendStepReady : signedBase64 ? styles.spendStepActive : styles.spendStepPending}`}><div className={styles.spendStepHeader}><span>5</span><div><h3>Finalizar a transação</h3><p>Valide a assinatura antes de usar a transação final em outro software.</p></div></div>{unsignedBase64 && <><button type="button" className={styles.primaryButton} onClick={validateSigned}>Validar e finalizar <Send aria-hidden="true" size={16} /></button>{finalTransaction && intent && <div className={styles.finalState}><strong><CircleCheck aria-hidden="true" size={18} /> Transação validada</strong><p>O TimeSats verificou a assinatura e finalizou a transação localmente.</p><p className={styles.finalWarning}>A transação ainda NÃO foi transmitida para a rede.</p><div className={styles.finalDetails}><span><small>TXID</small><code title={finalTransaction.txid}>{compactValue(finalTransaction.txid)}</code></span><span><small>Destino</small><code title={intent.destinationAddress}>{compactValue(intent.destinationAddress)}</code></span><span><small>Entrada</small>{intent.inputValueSats.toLocaleString("pt-BR")} sats</span><span><small>Saída</small>{intent.destinationValueSats.toLocaleString("pt-BR")} sats</span><span><small>Taxa</small>{intent.feeSats.toLocaleString("pt-BR")} sats</span><span><small>Desbloqueio</small>bloco {intent.unlockHeight}</span></div><div className={styles.technicalPanel}><p>Detalhes técnicos</p><label className={styles.rawTransaction} htmlFor="final-raw-transaction">Raw transaction final<textarea id="final-raw-transaction" value={finalTransaction.rawTransaction} readOnly spellCheck="false" aria-label="Raw transaction final pronta para transmissão" /></label><div className={styles.exportButtons}><button type="button" className={styles.subtleButton} onClick={() => copy(finalTransaction.rawTransaction)}><Copy aria-hidden="true" size={15} /> Copiar transação final</button><button type="button" className={styles.subtleButton} onClick={() => downloadText(finalTransaction.rawTransaction, `timesats-spend-${finalTransaction.txid}.hex`, "text/plain")}><Download aria-hidden="true" size={15} /> Exportar raw tx</button></div></div></div>}</>}</section>
      </div>
      <SpendSummary plan={plan} depositIndex={depositIndex} verified={verified} destination={destination} feeSats={feeSats} destinationValue={destinationValue} unsignedBase64={unsignedBase64} signedBase64={signedBase64} finalTransaction={finalTransaction} />
    </div>
    {error && <p role="alert" className={styles.dialogError}>{error}</p>}
    <input ref={signedFile} className={styles.visuallyHidden} type="file" accept=".psbt,application/octet-stream,text/plain" onChange={importSignedFile} aria-label="Importar PSBT assinado" />
  </section></div>;
}

export function LegacyCreatePlanDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (input: CreateVaultPlanInput) => void }) {
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

export function CreatePlanDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (input: CreateVaultPlanInput) => void }) {
  const [label, setLabel] = useState("");
  const [network, setNetwork] = useState<AllowedNetwork>("signet");
  const [extendedPublicKey, setExtendedPublicKey] = useState("");
  const [masterFingerprint, setMasterFingerprint] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [unlockHeight, setUnlockHeight] = useState("");
  const [policyVersion, setPolicyVersion] = useState<1 | 2>(2);
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    try {
      if (!/^\d+$/.test(unlockHeight)) throw new Error("O bloco de desbloqueio deve ser uma altura inteira.");
      onCreate({
        label,
        network,
        extendedPublicKey: extendedPublicKey.trim(),
        unlockHeight: Number(unlockHeight),
        policyVersion,
        keyOrigin: policyVersion === 2 ? { masterFingerprint: masterFingerprint.trim(), sourcePath: sourcePath.trim() } : undefined,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível criar o plano.");
    }
  }

  return <div className={styles.dialogBackdrop} role="presentation"><section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="create-plan-title"><button type="button" className={styles.closeButton} onClick={onClose} aria-label="Fechar criação de plano"><X aria-hidden="true" size={19} /></button><p className={styles.eyebrow}>NOVO PLANO</p><h2 id="create-plan-title">Crie seu compromisso</h2><p>Escolha o prazo e informe somente dados públicos da sua carteira. A TimeSats nunca pede seed ou chave privada.</p><form onSubmit={submit} noValidate>
    <fieldset className={styles.formSection}><legend>Seu plano</legend><div className={styles.formGrid}><label htmlFor="label">Nome do plano<input id="label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Minha Casa" autoComplete="off" /></label><label htmlFor="network">Rede<select id="network" value={network} onChange={(event) => setNetwork(event.target.value as AllowedNetwork)}>{allowedNetworks.map((item) => <option key={item} value={item}>{item === "signet" ? "Signet" : "Regtest"}</option>)}</select></label><label htmlFor="unlockHeight">Bloco de desbloqueio<input id="unlockHeight" value={unlockHeight} onChange={(event) => setUnlockHeight(event.target.value)} placeholder="840000" inputMode="numeric" autoComplete="off" /></label><label htmlFor="policyVersion">Política<select id="policyVersion" value={policyVersion} onChange={(event) => setPolicyVersion(Number(event.target.value) as 1 | 2)}><option value={2}>Compatível com signer externo</option><option value={1}>TimeSats V1 original</option></select></label></div></fieldset>
    <fieldset className={styles.formSection}><legend>Sua carteira <span>dados públicos</span></legend><label htmlFor="extendedPublicKey">Chave pública estendida (tpub)<input id="extendedPublicKey" value={extendedPublicKey} onChange={(event) => setExtendedPublicKey(event.target.value)} placeholder="tpub…" autoComplete="off" spellCheck="false" /></label>{policyVersion === 2 && <div className={styles.formGrid}><label htmlFor="masterFingerprint">Fingerprint mestre público<input id="masterFingerprint" value={masterFingerprint} onChange={(event) => setMasterFingerprint(event.target.value)} placeholder="d34db33f" autoComplete="off" spellCheck="false" /></label><label htmlFor="sourcePath">Caminho absoluto da tpub<input id="sourcePath" value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="m/84'/1'/0'/0" autoComplete="off" spellCheck="false" /></label></div>}<p className={styles.technicalNote}>Detalhes técnicos: esses dados são públicos, mas sensíveis à privacidade. Eles precisam corresponder à sua carteira.</p></fieldset>
    {error && <p role="alert" className={styles.dialogError}>{error}</p>}<div className={styles.dialogNotice}>EXPERIMENTAL · SIGNET / REGTEST ONLY · DO NOT SEND REAL BITCOIN</div><button type="submit" className={styles.primaryButton}>Criar plano <ArrowRight aria-hidden="true" size={18} /></button></form></section></div>;
}
