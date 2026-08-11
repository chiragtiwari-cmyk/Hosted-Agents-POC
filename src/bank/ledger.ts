/**
 * In-memory ledger for the simulated bank.
 *
 * Money is stored as integer minor units (pence) throughout. Never floats —
 * float arithmetic on currency produces drift that the tests would catch but
 * production wouldn't.
 *
 * The ledger is reseeded on every process start. There is no persistence in
 * slice one; see the design doc's "Later Slices" section.
 */
import bankFixture from "./bank.json" with { type: "json" };

export interface Account {
  id: string;
  name: string;
  sortCode: string;
  numberMasked: string;
  currency: string;
  balanceMinor: number;
  availableMinor: number;
  overdraftLimitMinor: number;
}

export interface Payee {
  id: string;
  name: string;
  aliases: string[];
  sortCode: string;
  numberMasked: string;
}

export interface Transaction {
  id: string;
  accountId: string;
  date: string;
  description: string;
  amountMinor: number;
  category: string;
  /**
   * Monotonic insertion counter, assigned by the ledger. Dates alone are not a
   * total order — fixtures share dates, and a payment committed under a test
   * clock can carry an earlier date than the fixtures it follows.
   */
  seq?: number;
}

export interface LoanProduct {
  id: string;
  name: string;
  aprPercent: number;
  minAmountMinor: number;
  maxAmountMinor: number;
  minTermMonths: number;
  maxTermMonths: number;
  minMonthlyIncomeMinor: number;
}

export interface Customer {
  id: string;
  name: string;
}

export interface BankData {
  customer: Customer;
  accounts: Account[];
  payees: Payee[];
  transactions: Transaction[];
  loanProducts: LoanProduct[];
  /**
   * Staged-but-uncommitted payments, persisted so a session resumed after idle
   * deprovisioning still holds its reservations. Without these, a restore would
   * silently release funds and a pending confirmation would dangle.
   */
  pending?: PendingAction[];
  /** Staged loan applications, persisted for the same reason as `pending`. */
  pendingApplications?: PendingApplication[];
  /** Submitted loan applications. */
  applications?: LoanApplication[];
  /** Counters, so restored sessions don't reissue tokens or transaction ids. */
  seq?: number;
  txnSeq?: number;
  appSeq?: number;
}

/** A transfer that has been validated but not yet committed. */
export interface PendingAction {
  token: string;
  fromAccountId: string;
  toPayeeId: string;
  amountMinor: number;
  createdAtMs: number;
}

/** A loan application validated but not yet submitted. */
export interface PendingApplication {
  token: string;
  productId: string;
  amountMinor: number;
  termMonths: number;
  aprPercent: number;
  monthlyPaymentMinor: number;
  createdAtMs: number;
}

/** A submitted loan application. */
export interface LoanApplication {
  reference: string;
  productId: string;
  productName: string;
  amountMinor: number;
  termMonths: number;
  aprPercent: number;
  monthlyPaymentMinor: number;
  submittedAtMs: number;
  status: "submitted" | "in_review";
}

export interface Receipt {
  reference: string;
  fromAccountId: string;
  toPayeeId: string;
  amountMinor: number;
  newBalanceMinor: number;
}

/** Thrown for conditions the user should be told about, not stack-traced. */
export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unknown_account"
      | "unknown_payee"
      | "insufficient_funds"
      | "invalid_amount"
      | "unknown_token"
      | "token_expired"
      | "unknown_product"
      | "invalid_term"
      | "not_eligible",
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

/** Pending confirmations older than this are refused. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Standard amortising loan payment, in minor units.
 *
 * Lives here rather than in the loans agent because the ledger needs it too, to
 * quote a staged application. Computed in TypeScript, never by the model — a
 * wrong repayment figure in a banking demo is not a cosmetic problem.
 */
export function amortisingPaymentMinor(
  principalMinor: number,
  aprPercent: number,
  termMonths: number,
): number {
  if (termMonths <= 0) throw new Error("termMonths must be positive");
  const monthlyRate = aprPercent / 100 / 12;
  if (monthlyRate === 0) return Math.round(principalMinor / termMonths);
  const factor = Math.pow(1 + monthlyRate, termMonths);
  return Math.round((principalMinor * monthlyRate * factor) / (factor - 1));
}

export function formatMoney(minor: number, currency = "GBP"): string {
  const symbol = currency === "GBP" ? "£" : "";
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 100);
  const pence = String(abs % 100).padStart(2, "0");
  return `${sign}${symbol}${major.toLocaleString("en-GB")}.${pence}`;
}

export class Ledger {
  private accounts: Map<string, Account>;
  private payees: Payee[];
  private transactions: Transaction[];
  private loanProducts: LoanProduct[];
  private pending = new Map<string, PendingAction>();
  private pendingApplications = new Map<string, PendingApplication>();
  private applications: LoanApplication[] = [];
  private seq = 0;
  private txnSeq = 0;
  private appSeq = 0;
  readonly customer: Customer;

  /**
   * @param now  Injectable clock. Tests use it to age pending actions past the
   *             TTL without sleeping.
   */
  constructor(
    data: BankData = structuredClone(bankFixture) as BankData,
    private now: () => number = () => Date.now(),
  ) {
    this.customer = data.customer;
    this.accounts = new Map(data.accounts.map((a) => [a.id, a]));
    this.payees = data.payees;
    this.loanProducts = data.loanProducts;
    // Fixtures are authored newest-first, so invert the index: earlier entries
    // get higher seq and win same-date ties. Ledger-recorded payments then
    // continue above the highest fixture seq.
    const count = data.transactions.length;
    this.transactions = data.transactions.map((t, i) => ({ ...t, seq: t.seq ?? count - i }));
    this.txnSeq = data.txnSeq ?? count;
    this.seq = data.seq ?? 0;
    // Restore staged payments. Their reservations are already reflected in the
    // persisted availableMinor, so do NOT re-apply them here.
    for (const pending of data.pending ?? []) {
      this.pending.set(pending.token, { ...pending });
    }
    for (const application of data.pendingApplications ?? []) {
      this.pendingApplications.set(application.token, { ...application });
    }
    this.applications = (data.applications ?? []).map((a) => ({ ...a }));
    this.appSeq = data.appSeq ?? this.applications.length;
  }

  /**
   * Serialise for session persistence. Includes staged payments and counters so
   * a restored session keeps its reservations and never reissues a token.
   */
  toJSON(): BankData {
    return {
      customer: { ...this.customer },
      accounts: this.listAccounts(),
      payees: this.listPayees(),
      transactions: this.transactions.map((t) => ({ ...t })),
      loanProducts: this.listLoanProducts(),
      pending: [...this.pending.values()].map((p) => ({ ...p })),
      pendingApplications: [...this.pendingApplications.values()].map((p) => ({ ...p })),
      applications: this.applications.map((a) => ({ ...a })),
      seq: this.seq,
      txnSeq: this.txnSeq,
      appSeq: this.appSeq,
    };
  }

  listAccounts(): Account[] {
    return [...this.accounts.values()].map((a) => ({ ...a }));
  }

  getAccount(id: string): Account {
    const account = this.accounts.get(id);
    if (!account) throw new LedgerError(`No account with id ${id}`, "unknown_account");
    return { ...account };
  }

  /** Resolve free text ("savings", "Current") to an account. */
  findAccount(hint: string | undefined): Account | undefined {
    if (!hint) return undefined;
    const needle = hint.trim().toLowerCase();
    if (!needle) return undefined;
    for (const account of this.accounts.values()) {
      if (
        account.id.toLowerCase() === needle ||
        account.name.toLowerCase() === needle ||
        account.name.toLowerCase().includes(needle) ||
        account.numberMasked.endsWith(needle)
      ) {
        return { ...account };
      }
    }
    return undefined;
  }

  /** The account used when the customer doesn't say which one. */
  defaultAccount(): Account {
    const current = this.findAccount("current");
    if (current) return current;
    const first = this.listAccounts()[0];
    if (!first) throw new LedgerError("Ledger has no accounts", "unknown_account");
    return first;
  }

  listPayees(): Payee[] {
    return this.payees.map((p) => ({ ...p }));
  }

  /** Resolve free text ("alice", "my credit card") to a payee. */
  findPayee(hint: string): Payee | undefined {
    const needle = hint.trim().toLowerCase();
    if (!needle) return undefined;
    const match = this.payees.find(
      (p) =>
        p.id.toLowerCase() === needle ||
        p.name.toLowerCase() === needle ||
        p.aliases.some((a) => a.toLowerCase() === needle),
    );
    if (match) return { ...match };
    // Fall back to a looser contains match so "alice chen" and "aurora card" work.
    const loose = this.payees.find(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        needle.includes(p.name.toLowerCase()) ||
        p.aliases.some((a) => needle.includes(a.toLowerCase())),
    );
    return loose ? { ...loose } : undefined;
  }

  recentTransactions(accountId?: string, limit = 10): Transaction[] {
    return this.transactions
      .filter((t) => !accountId || t.accountId === accountId)
      .slice()
      // Newest first by date, ties broken by insertion order. Ledger-recorded
      // payments carry a `seq` above every fixture, so a just-committed payment
      // sorts above same-dated fixtures.
      .sort((a, b) => (a.date === b.date ? (b.seq ?? 0) - (a.seq ?? 0) : a.date < b.date ? 1 : -1))
      .slice(0, limit)
      .map((t) => ({ ...t }));
  }

  listLoanProducts(): LoanProduct[] {
    return this.loanProducts.map((p) => ({ ...p }));
  }

  /** Monthly income inferred from credited salary transactions. */
  estimatedMonthlyIncomeMinor(): number {
    const income = this.transactions.filter((t) => t.category === "income" && t.amountMinor > 0);
    if (income.length === 0) return 0;
    const total = income.reduce((sum, t) => sum + t.amountMinor, 0);
    const months = new Set(income.map((t) => t.date.slice(0, 7))).size || 1;
    return Math.round(total / months);
  }

  /**
   * Validate a transfer and hold it as pending. Nothing moves.
   * Returns a token the caller must present to commit.
   */
  stagePayment(input: {
    fromAccountHint?: string;
    toPayeeHint: string;
    amountMinor: number;
  }): { pending: PendingAction; from: Account; to: Payee } {
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new LedgerError(
        "Amount must be a positive whole number of pence.",
        "invalid_amount",
      );
    }

    const from = input.fromAccountHint
      ? this.findAccount(input.fromAccountHint)
      : this.defaultAccount();
    if (!from) {
      throw new LedgerError(
        `I couldn't find an account matching "${input.fromAccountHint}".`,
        "unknown_account",
      );
    }

    const to = this.findPayee(input.toPayeeHint);
    if (!to) {
      throw new LedgerError(
        `"${input.toPayeeHint}" isn't in your saved payees.`,
        "unknown_payee",
      );
    }

    this.assertSufficientFunds(from, input.amountMinor);

    const pending: PendingAction = {
      token: `pend-${++this.seq}-${Math.abs(this.hash(`${from.id}:${to.id}:${input.amountMinor}:${this.seq}`))}`,
      fromAccountId: from.id,
      toPayeeId: to.id,
      amountMinor: input.amountMinor,
      createdAtMs: this.now(),
    };
    this.pending.set(pending.token, pending);

    // Reserve the funds. Without this, two payments staged back to back would
    // each validate against the full balance and could jointly overdraw the
    // account. `balanceMinor` is untouched — nothing has moved yet.
    const live = this.accounts.get(from.id)!;
    live.availableMinor -= input.amountMinor;

    return { pending, from: { ...live }, to };
  }

  peekPending(token: string): PendingAction | undefined {
    const pending = this.pending.get(token);
    return pending ? { ...pending } : undefined;
  }

  /**
   * Commit a previously staged transfer.
   *
   * Re-validates funds at commit time: the token references an intent, it is
   * never a pre-authorization. Balances can change between turns.
   */
  commitPayment(token: string): { receipt: Receipt; from: Account; to: Payee } {
    const pending = this.pending.get(token);
    if (!pending) {
      throw new LedgerError(
        "That confirmation has already been used or was never issued.",
        "unknown_token",
      );
    }

    if (this.now() - pending.createdAtMs > PENDING_TTL_MS) {
      this.releaseReservation(pending);
      this.pending.delete(token);
      throw new LedgerError(
        "That confirmation expired. Please start the payment again.",
        "token_expired",
      );
    }

    const from = this.accounts.get(pending.fromAccountId);
    if (!from) {
      this.pending.delete(token);
      throw new LedgerError("The source account no longer exists.", "unknown_account");
    }
    const to = this.payees.find((p) => p.id === pending.toPayeeId);
    if (!to) {
      this.releaseReservation(pending);
      this.pending.delete(token);
      throw new LedgerError("The payee no longer exists.", "unknown_payee");
    }

    // Release this payment's own reservation before re-validating, so it is not
    // counted twice, then re-check against everything else still outstanding.
    from.availableMinor += pending.amountMinor;

    // Re-validate. This is the point of the whole design: the token references an
    // intent, never a pre-authorization. Balances change between turns.
    try {
      this.assertSufficientFunds(from, pending.amountMinor);
    } catch (error) {
      // Re-reserve so a refused commit leaves the reservation as it was.
      from.availableMinor -= pending.amountMinor;
      throw error;
    }

    from.balanceMinor -= pending.amountMinor;
    from.availableMinor -= pending.amountMinor;

    // A transfer to an internal account credits it; external payees just leave.
    const internal = this.accounts.get(pending.toPayeeId);
    if (internal) {
      internal.balanceMinor += pending.amountMinor;
      internal.availableMinor += pending.amountMinor;
    }

    const reference = `REF${String(1000 + ++this.seq)}`;
    this.transactions.unshift({
      id: `txn-${reference}`,
      accountId: from.id,
      date: new Date(this.now()).toISOString().slice(0, 10),
      description: `Payment to ${to.name}`,
      amountMinor: -pending.amountMinor,
      category: "transfer",
      seq: ++this.txnSeq,
    });

    this.pending.delete(token);

    return {
      receipt: {
        reference,
        fromAccountId: from.id,
        toPayeeId: to.id,
        amountMinor: pending.amountMinor,
        newBalanceMinor: from.balanceMinor,
      },
      from: { ...from },
      to: { ...to },
    };
  }

  /**
   * Apply a debit that did not originate from this assistant — a direct debit or
   * card settlement clearing. Bypasses reservations deliberately: the point is to
   * model balance movement the assistant did not cause, which is what makes
   * commit-time re-validation necessary rather than theoretical.
   *
   * Also the hook the workshop uses to demonstrate a refused confirmation.
   */
  applyExternalDebit(accountId: string, amountMinor: number, description = "Direct debit"): void {
    const account = this.accounts.get(accountId);
    if (!account) throw new LedgerError(`No account with id ${accountId}`, "unknown_account");
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new LedgerError("Debit must be a positive whole number of pence.", "invalid_amount");
    }
    account.balanceMinor -= amountMinor;
    account.availableMinor -= amountMinor;
    this.transactions.unshift({
      id: `txn-ext-${++this.txnSeq}`,
      accountId,
      date: new Date(this.now()).toISOString().slice(0, 10),
      description,
      amountMinor: -amountMinor,
      category: "direct_debit",
      seq: this.txnSeq,
    });
  }

  /* ------------------------------------------------------ loan applications */

  listApplications(): LoanApplication[] {
    return this.applications.map((a) => ({ ...a }));
  }

  peekPendingApplication(token: string): PendingApplication | undefined {
    const pending = this.pendingApplications.get(token);
    return pending ? { ...pending } : undefined;
  }

  /**
   * Validate a loan application and hold it as pending. Nothing is submitted.
   *
   * Unlike a payment there is no money to reserve, so eligibility is the thing
   * that must be re-checked at submit time — income can fall, or the requested
   * amount can stop qualifying, between the quote and the confirmation.
   */
  stageApplication(input: {
    productId: string;
    amountMinor: number;
    termMonths: number;
  }): { pending: PendingApplication; product: LoanProduct } {
    const product = this.loanProducts.find((p) => p.id === input.productId);
    if (!product) {
      throw new LedgerError(`No loan product with id ${input.productId}`, "unknown_product");
    }

    this.assertLoanEligible(product, input.amountMinor, input.termMonths);

    const monthlyPaymentMinor = amortisingPaymentMinor(
      input.amountMinor,
      product.aprPercent,
      input.termMonths,
    );

    const pending: PendingApplication = {
      token: `appl-${++this.seq}-${Math.abs(this.hash(`${product.id}:${input.amountMinor}:${this.seq}`))}`,
      productId: product.id,
      amountMinor: input.amountMinor,
      termMonths: input.termMonths,
      aprPercent: product.aprPercent,
      monthlyPaymentMinor,
      createdAtMs: this.now(),
    };
    this.pendingApplications.set(pending.token, pending);
    return { pending, product: { ...product } };
  }

  /**
   * Submit a staged application. Re-validates eligibility, so a token is a
   * reference to an intent rather than an approval.
   */
  submitApplication(token: string): { application: LoanApplication; product: LoanProduct } {
    const pending = this.pendingApplications.get(token);
    if (!pending) {
      throw new LedgerError(
        "That application confirmation has already been used or was never issued.",
        "unknown_token",
      );
    }

    if (this.now() - pending.createdAtMs > PENDING_TTL_MS) {
      this.pendingApplications.delete(token);
      throw new LedgerError(
        "That application confirmation expired. Please ask for a fresh quote.",
        "token_expired",
      );
    }

    const product = this.loanProducts.find((p) => p.id === pending.productId);
    if (!product) {
      this.pendingApplications.delete(token);
      throw new LedgerError("That loan product is no longer offered.", "unknown_product");
    }

    // Re-validate. Eligibility is not frozen at quote time.
    this.assertLoanEligible(product, pending.amountMinor, pending.termMonths);

    const application: LoanApplication = {
      reference: `APP${1000 + ++this.appSeq}`,
      productId: product.id,
      productName: product.name,
      amountMinor: pending.amountMinor,
      termMonths: pending.termMonths,
      aprPercent: pending.aprPercent,
      monthlyPaymentMinor: pending.monthlyPaymentMinor,
      submittedAtMs: this.now(),
      status: "in_review",
    };
    this.applications.unshift(application);
    this.pendingApplications.delete(token);

    return { application, product: { ...product } };
  }

  /** Discard a staged application the customer declined. */
  cancelPendingApplication(token: string): boolean {
    return this.pendingApplications.delete(token);
  }

  /** Shared by quoting and by submit-time re-validation. */
  private assertLoanEligible(
    product: LoanProduct,
    amountMinor: number,
    termMonths: number,
  ): void {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new LedgerError("Loan amount must be a positive whole number of pence.", "invalid_amount");
    }
    if (!Number.isInteger(termMonths) || termMonths <= 0) {
      throw new LedgerError("Loan term must be a positive whole number of months.", "invalid_term");
    }
    if (amountMinor < product.minAmountMinor || amountMinor > product.maxAmountMinor) {
      throw new LedgerError(
        `${product.name} lends between ${formatMoney(product.minAmountMinor)} and ` +
          `${formatMoney(product.maxAmountMinor)}.`,
        "not_eligible",
      );
    }
    if (termMonths < product.minTermMonths || termMonths > product.maxTermMonths) {
      throw new LedgerError(
        `${product.name} terms run ${product.minTermMonths}–${product.maxTermMonths} months.`,
        "not_eligible",
      );
    }
    const income = this.estimatedMonthlyIncomeMinor();
    if (income < product.minMonthlyIncomeMinor) {
      throw new LedgerError(
        `${product.name} needs monthly income of at least ` +
          `${formatMoney(product.minMonthlyIncomeMinor)}; yours is estimated at ` +
          `${formatMoney(income)}.`,
        "not_eligible",
      );
    }
  }

  /** Discard a staged payment the customer declined, releasing its reservation. */
  cancelPending(token: string): boolean {
    const pending = this.pending.get(token);
    if (!pending) return false;
    this.releaseReservation(pending);
    return this.pending.delete(token);
  }

  /** Return a pending payment's reserved funds to the available balance. */
  private releaseReservation(pending: PendingAction): void {
    const account = this.accounts.get(pending.fromAccountId);
    if (account) account.availableMinor += pending.amountMinor;
  }

  private assertSufficientFunds(account: Account, amountMinor: number): void {
    const ceiling = account.availableMinor + account.overdraftLimitMinor;
    if (amountMinor > ceiling) {
      throw new LedgerError(
        `${formatMoney(amountMinor)} exceeds what's available in ${account.name} ` +
          `(${formatMoney(account.availableMinor)}` +
          (account.overdraftLimitMinor > 0
            ? ` plus a ${formatMoney(account.overdraftLimitMinor)} overdraft`
            : "") +
          ").",
        "insufficient_funds",
      );
    }
  }

  private hash(input: string): number {
    let h = 0;
    for (let i = 0; i < input.length; i++) {
      h = (h << 5) - h + input.charCodeAt(i);
      h |= 0;
    }
    return h;
  }
}
