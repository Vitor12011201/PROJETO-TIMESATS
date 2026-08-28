import { useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import {
  ArrowRight,
  Bitcoin,
  CalendarDays,
  ChevronRight,
  CircleCheck,
  Copy,
  Download,
  FileKey,
  FileUp,
  Hourglass,
  House,
  KeyRound,
  Landmark,
  LockKeyhole,
  Plus,
  Send,
  ShieldCheck,
  Target,
  TrendingUp,
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
} from "@/bitcoin";
import type {
  AllowedNetwork,
  CreateVaultPlanInput,
  DerivedDeposit,
  VaultPlan,
  VaultSpendIntent,
  VaultUtxo,
} from "@/bitcoin";
import packageJson from "../../package.json";
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
      <p className={styles.eyebrow}>TIMESATS · V{packageJson.version}</p>
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
  onPrepareSpend: (depositIndex: number) => void;
}

export function ActivePlanCard({ activePlan, deposits, onAdd, onCopy, onCreate, onExport, onPrepareSpend }: ActivePlanCardProps) {
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
      <div className={styles.depositList}>{deposits.map((deposit) => <DepositRow key={deposit.index} deposit={deposit} onCopy={onCopy} onPrepare={() => onPrepareSpend(deposit.index)} />)}</div>
      <div className={styles.planActions}><button type="button" className={styles.addButton} onClick={onAdd}>Adicionar sats a este plano <Plus aria-hidden="true" size={19} /></button><button type="button" className={styles.recoveryButton} onClick={onExport}><Download aria-hidden="true" size={15} /> Recovery</button></div>
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function DepositRow({ deposit, onCopy, onPrepare }: { deposit: DerivedDeposit; onCopy: (address: string) => Promise<void>; onPrepare: () => void }) {
  return <article className={styles.depositRow}>
    <span className={styles.depositIcon}><CircleCheck aria-hidden="true" size={18} /></span>
    <div className={styles.depositInfo}><strong>Depósito #{deposit.index}</strong><span>Endereço de depósito</span><code title={deposit.address}>{shortenedAddress(deposit.address)}</code></div>
    <button className={styles.copyButton} type="button" onClick={() => onCopy(deposit.address)} aria-label={`Copiar endereço do depósito ${deposit.index}`}><Copy aria-hidden="true" size={15} /></button>
    <div className={styles.depositState}><strong>Índice #{deposit.index}</strong><span>Pronto para depósito</span></div>
    <button className={styles.prepareButton} type="button" onClick={onPrepare}>Preparar gasto</button>
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
    try { setSignedBase64((await file.text()).trim()); setFinalTransaction(null); setError(null); } catch { setError("Não foi possível ler o arquivo PSBT."); }
    finally { event.target.value = ""; }
  }

  const destinationValue = verified && /^\d+$/.test(feeSats) && Number(feeSats) < verified.valueSats ? verified.valueSats - Number(feeSats) : null;
  return <div className={styles.dialogBackdrop} role="presentation"><section className={`${styles.dialog} ${styles.spendDialog}`} role="dialog" aria-modal="true" aria-labelledby="prepare-spend-title">
    <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Fechar preparação de gasto"><X aria-hidden="true" size={19} /></button>
    <p className={styles.eyebrow}>GASTO OFFLINE · DEPÓSITO #{depositIndex}</p><h2 id="prepare-spend-title">Preparar PSBT</h2>
    <p>TimeSats prepara e verifica. Sua carteira assina fora desta aplicação. Nenhuma chave privada é necessária aqui. TimeSats não transmite esta transação.</p>
    <div className={styles.spendStep}><h3>1. Verificar UTXO</h3><label htmlFor="funding-hex">Transação de funding em raw hex<textarea id="funding-hex" value={fundingHex} onChange={(event) => { setFundingHex(event.target.value); invalidateFunding(); }} spellCheck="false" autoComplete="off" /></label><label htmlFor="funding-vout">Vout<input id="funding-vout" value={vout} onChange={(event) => { setVout(event.target.value); invalidateFunding(); }} inputMode="numeric" autoComplete="off" /></label><button type="button" className={styles.subtleButton} onClick={verifyUtxo}>Verificar UTXO</button>
      {verified && <div className={styles.verifiedBox}><strong>UTXO verificado</strong><span>TXID: <code>{verified.txid}</code> · Vout: {verified.vout}</span><span>Valor: {verified.valueSats.toLocaleString("pt-BR")} sats</span><span>Script corresponde ao Depósito #{depositIndex}.</span><small>Isto prova o output na transação informada, não que ele ainda esteja não gasto.</small></div>}</div>
    <div className={styles.spendStep}><h3>2. Destino e fee</h3><label htmlFor="destination-address">Endereço de destino<input id="destination-address" value={destination} onChange={(event) => { setDestination(event.target.value); invalidateSpendArtifacts(); }} spellCheck="false" autoComplete="off" placeholder={plan.policy.network === "regtest" ? "bcrt1…" : "tb1…"} /></label><label htmlFor="fee-sats">Fee (sats)<input id="fee-sats" value={feeSats} onChange={(event) => { setFeeSats(event.target.value); invalidateSpendArtifacts(); }} inputMode="numeric" autoComplete="off" /></label>{verified && <div className={styles.spendSummary}><span>Entrada <strong>{verified.valueSats.toLocaleString("pt-BR")} sats</strong></span><span>Destino <strong>{destinationValue === null ? "—" : `${destinationValue.toLocaleString("pt-BR")} sats`}</strong></span><span>Fee <strong>{feeSats || "—"} sats</strong></span><span>Unlock <strong>bloco {verified.unlockHeight}</strong></span><span>Sequence <strong>0xfffffffe</strong></span></div>}<button type="button" className={styles.primaryButton} onClick={generatePsbt} disabled={!verified}>Gerar PSBT não assinado <FileKey aria-hidden="true" size={17} /></button></div>
    {unsignedBase64 && <div className={styles.spendStep}><h3>3. PSBT pronto</h3><p className={styles.mutedText}>Um PSBT revela UTXO, valores, scripts, chave pública e destino. Compartilhe-o somente com o signer escolhido.</p><div className={styles.exportButtons}><button type="button" className={styles.subtleButton} onClick={() => copy(unsignedBase64)}><Copy aria-hidden="true" size={15} /> Copiar Base64</button><button type="button" className={styles.subtleButton} onClick={() => downloadText(unsignedBase64, `timesats-deposit-${depositIndex}.psbt`, "application/octet-stream")}><Download aria-hidden="true" size={15} /> Exportar .psbt</button></div><p className={styles.mutedText}>Leve este PSBT a um signer compatível. Preparar ou assinar antecipadamente não desbloqueia o UTXO.</p></div>}
    {unsignedBase64 && <div className={styles.spendStep}><h3>4. Importar PSBT assinado</h3><label htmlFor="signed-psbt">PSBT assinado (Base64)<textarea id="signed-psbt" value={signedBase64} onChange={(event) => { setSignedBase64(event.target.value); setFinalTransaction(null); }} spellCheck="false" autoComplete="off" /></label><div className={styles.exportButtons}><button type="button" className={styles.subtleButton} onClick={() => signedFile.current?.click()}><FileUp aria-hidden="true" size={15} /> Importar arquivo</button><button type="button" className={styles.primaryButton} onClick={validateSigned}>Validar e finalizar <Send aria-hidden="true" size={16} /></button></div>{finalTransaction && intent && <div className={styles.verifiedBox}><strong>Assinatura válida · raw transaction pronta para transmissão</strong><span>TXID: <code>{finalTransaction.txid}</code></span><div className={styles.spendSummary}><span>Destino <strong><code>{intent.destinationAddress}</code></strong></span><span>Entrada <strong>{intent.inputValueSats.toLocaleString("pt-BR")} sats</strong></span><span>Saída <strong>{intent.destinationValueSats.toLocaleString("pt-BR")} sats</strong></span><span>Fee <strong>{intent.feeSats.toLocaleString("pt-BR")} sats</strong></span><span>Unlock <strong>bloco {intent.unlockHeight}</strong></span></div><label className={styles.rawTransaction} htmlFor="final-raw-transaction">Raw transaction final<textarea id="final-raw-transaction" value={finalTransaction.rawTransaction} readOnly spellCheck="false" aria-label="Raw transaction final pronta para transmissão" /></label><div className={styles.exportButtons}><button type="button" className={styles.subtleButton} onClick={() => copy(finalTransaction.rawTransaction)}><Copy aria-hidden="true" size={15} /> Copiar transação final</button><button type="button" className={styles.subtleButton} onClick={() => downloadText(finalTransaction.rawTransaction, `timesats-spend-${finalTransaction.txid}.hex`, "text/plain")}><Download aria-hidden="true" size={15} /> Exportar raw tx</button></div><small>Validada e finalizada localmente. TimeSats não transmite esta transação.</small></div>}</div>}
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

  return <div className={styles.dialogBackdrop} role="presentation"><section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="create-plan-title"><button type="button" className={styles.closeButton} onClick={onClose} aria-label="Fechar criação de plano"><X aria-hidden="true" size={19} /></button><p className={styles.eyebrow}>NOVO PLANO</p><h2 id="create-plan-title">Crie seu compromisso</h2><p>Informe apenas dados públicos do signer. Nunca informe seed ou chave privada.</p><form onSubmit={submit} noValidate><label htmlFor="label">Nome do plano<input id="label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Minha Casa" autoComplete="off" /></label><label htmlFor="network">Rede<select id="network" value={network} onChange={(event) => setNetwork(event.target.value as AllowedNetwork)}>{allowedNetworks.map((item) => <option key={item} value={item}>{item === "signet" ? "Signet" : "Regtest"}</option>)}</select></label><label htmlFor="policyVersion">Política<select id="policyVersion" value={policyVersion} onChange={(event) => setPolicyVersion(Number(event.target.value) as 1 | 2)}><option value={2}>Compatível com signer externo</option><option value={1}>TimeSats V1 original</option></select></label><label htmlFor="extendedPublicKey">Chave pública estendida (tpub)<input id="extendedPublicKey" value={extendedPublicKey} onChange={(event) => setExtendedPublicKey(event.target.value)} placeholder="tpub…" autoComplete="off" spellCheck="false" /></label>{policyVersion === 2 && <><label htmlFor="masterFingerprint">Fingerprint mestre público<input id="masterFingerprint" value={masterFingerprint} onChange={(event) => setMasterFingerprint(event.target.value)} placeholder="d34db33f" autoComplete="off" spellCheck="false" /></label><label htmlFor="sourcePath">Caminho absoluto da tpub<input id="sourcePath" value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="m/84'/1'/0'/0" autoComplete="off" spellCheck="false" /></label><p>São dados públicos, porém sensíveis à privacidade. Devem corresponder exatamente à wallet Bitcoin Core.</p></>}<label htmlFor="unlockHeight">Bloco de desbloqueio<input id="unlockHeight" value={unlockHeight} onChange={(event) => setUnlockHeight(event.target.value)} placeholder="840000" inputMode="numeric" autoComplete="off" /></label>{error && <p role="alert" className={styles.dialogError}>{error}</p>}<div className={styles.dialogNotice}>EXPERIMENTAL · SIGNET / REGTEST ONLY · DO NOT SEND REAL BITCOIN</div><button type="submit" className={styles.primaryButton}>Criar plano <ArrowRight aria-hidden="true" size={18} /></button></form></section></div>;
}
