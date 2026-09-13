/** Application-owned relational storage. All writers lock the purchase parent first. */
import { randomUUID } from 'node:crypto'
import type { Queryable, Transaction } from '@affordance/pg'
import { type Buyer, type Purchase, PurchaseState, type Wire } from './state.js'

export const bootstrapPurchases = async (q: Queryable): Promise<void> => {
  await q.query(`
    create table if not exists house_purchases (
      id text primary key, address text not null, target double precision not null,
      closed_at text, deed_recorded_at text, offer_accepted_at text, inspection_report_id text,
      escrow_status text not null default 'none', application_id text, account_id text,
      funding_amount double precision, funding_issued_at text, funding_reference text,
      notes text[] not null default '{}'
    );
    create table if not exists purchase_buyers (
      purchase_id text not null references house_purchases(id), id text not null,
      position bigserial, name text not null, committed double precision,
      verification_status text not null default 'none', check_id text, flagged_at text,
      hits text[] not null default '{}', escalated_at text,
      envelope_id text, signed boolean not null default false, signed_at text,
      primary key (purchase_id,id)
    );
    create table if not exists purchase_wires (
      purchase_id text not null references house_purchases(id), id text not null, position bigserial,
      buyer_id text not null, amount double precision not null, from_account text not null,
      received_at text not null, outcome text not null, resolution text,
      primary key (purchase_id,id)
    );
  `)
}
export const protectPurchase = async (
  tx: Transaction,
  id: string,
): Promise<void> => {
  const { rows } = await tx.query(
    'select id from house_purchases where id = $1 for update',
    [id],
  )
  if (rows.length === 0) throw new Error(`purchase '${id}' does not exist`)
}
/** Caller supplies one query/transaction snapshot; parent protection is required for writes. */
export const loadPurchase = async (
  q: Queryable,
  id: string,
): Promise<Purchase> => {
  const { rows } = await q.query(
    `select
    json_build_object('address',address,'target',target,'closedAt',closed_at,'deedRecordedAt',deed_recorded_at) as purchase,
    json_build_object('offerAcceptedAt',offer_accepted_at,'inspectionReportId',inspection_report_id) as property,
    json_build_object('status',escrow_status,'applicationId',application_id,'accountId',account_id) as escrow,
    case when funding_reference is null then null else json_build_object('amount',funding_amount,'issuedAt',funding_issued_at,'reference',funding_reference) end as "fundingCall",
    notes,
    coalesce((select json_agg(json_build_object('id',b.id,'name',b.name,'committed',b.committed,
      'verification',json_build_object('status',b.verification_status,'checkId',b.check_id,'flaggedAt',b.flagged_at,'hits',b.hits,'escalatedAt',b.escalated_at),
      'agreement',case when b.envelope_id is null then null else json_build_object('envelopeId',b.envelope_id,'signed',b.signed,'signedAt',b.signed_at) end
    ) order by b.position) from purchase_buyers b where b.purchase_id = p.id),'[]') as buyers,
    coalesce((select json_agg(json_build_object('id',w.id,'buyerId',w.buyer_id,'amount',w.amount,'fromAccount',w.from_account,'receivedAt',w.received_at,'outcome',w.outcome,'resolution',w.resolution) order by w.position)
      from purchase_wires w where w.purchase_id = p.id),'[]') as wires
    from house_purchases p where p.id = $1`,
    [id],
  )
  if (!rows[0]) throw new Error(`purchase '${id}' does not exist`)
  return PurchaseState.parse(rows[0])
}
export const purchaseRepositories = (tx: Transaction, id: string) => {
  const update = async (sql: string, values: unknown[] = []) => {
    const result = await tx.query(sql, [id, ...values])
    if (result.rowCount !== 1)
      throw new Error('domain record not found on this purchase')
  }
  return {
    note: (note: string) =>
      update(
        'update house_purchases set notes = array_append(notes,$2) where id = $1',
        [note],
      ),
    acceptOffer: (at: string) =>
      update('update house_purchases set offer_accepted_at=$2 where id=$1', [
        at,
      ]),
    inspect: (report: string) =>
      update('update house_purchases set inspection_report_id=$2 where id=$1', [
        report,
      ]),
    requestEscrow: (applicationId: string) =>
      update(
        "update house_purchases set escrow_status='requested', application_id=$2 where id=$1",
        [applicationId],
      ),
    recordEscrow: (accountId: string) =>
      update(
        "update house_purchases set escrow_status='open', account_id=$2 where id=$1",
        [accountId],
      ),
    invite: (name: string) =>
      update(
        'insert into purchase_buyers (purchase_id,id,name) values ($1,$2,$3)',
        [`buyer:${randomUUID()}`, name],
      ),
    commit: (buyer: string, amount: number) =>
      update(
        'update purchase_buyers set committed=$3 where purchase_id=$1 and id=$2',
        [buyer, amount],
      ),
    requestVerification: (buyer: string, checkId: string) =>
      update(
        "update purchase_buyers set verification_status='pending',check_id=$3 where purchase_id=$1 and id=$2",
        [buyer, checkId],
      ),
    verify: (
      buyer: string,
      status: string,
      hits: string[],
      flaggedAt: string | null,
    ) =>
      update(
        'update purchase_buyers set verification_status=$3,hits=$4,flagged_at=$5 where purchase_id=$1 and id=$2',
        [buyer, status, hits, flaggedAt],
      ),
    escalate: (buyer: string, at: string) =>
      update(
        "update purchase_buyers set verification_status='escalated',escalated_at=$3 where purchase_id=$1 and id=$2",
        [buyer, at],
      ),
    clear: (buyer: string, cleared: boolean) =>
      update(
        'update purchase_buyers set verification_status=$3 where purchase_id=$1 and id=$2',
        [buyer, cleared ? 'clear' : 'rejected'],
      ),
    agreement: (buyer: string, envelopeId: string) =>
      update(
        'update purchase_buyers set envelope_id=$3,signed=false,signed_at=null where purchase_id=$1 and id=$2',
        [buyer, envelopeId],
      ),
    sign: (buyer: string, at: string) =>
      update(
        'update purchase_buyers set signed=true,signed_at=$3 where purchase_id=$1 and id=$2',
        [buyer, at],
      ),
    funding: (amount: number, at: string, reference: string) =>
      update(
        'update house_purchases set funding_amount=$2,funding_issued_at=$3,funding_reference=$4 where id=$1',
        [amount, at, reference],
      ),
    wire: (w: Wire) =>
      update(
        'insert into purchase_wires (purchase_id,id,buyer_id,amount,from_account,received_at,outcome,resolution) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          w.id,
          w.buyerId,
          w.amount,
          w.fromAccount,
          w.receivedAt,
          w.outcome,
          w.resolution,
        ],
      ),
    resolveWire: (wire: string, resolution: string) =>
      update(
        'update purchase_wires set resolution=$3 where purchase_id=$1 and id=$2',
        [wire, resolution],
      ),
    close: (at: string) =>
      update('update house_purchases set closed_at=$2 where id=$1', [at]),
    recordDeed: (at: string) =>
      update('update house_purchases set deed_recorded_at=$2 where id=$1', [
        at,
      ]),
  }
}
export type PurchaseRepositories = ReturnType<typeof purchaseRepositories>

/** Application creation; attaching framework metadata is a separate idempotent operation. */
export const insertPurchase = async (
  tx: Transaction,
  value: unknown,
): Promise<string> => {
  const s = PurchaseState.parse(value)
  const id = `purchase:${randomUUID()}`
  await tx.query(
    `insert into house_purchases (id,address,target,closed_at,deed_recorded_at,offer_accepted_at,inspection_report_id,escrow_status,application_id,account_id,funding_amount,funding_issued_at,funding_reference,notes)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      s.purchase.address,
      s.purchase.target,
      s.purchase.closedAt,
      s.purchase.deedRecordedAt,
      s.property.offerAcceptedAt,
      s.property.inspectionReportId,
      s.escrow.status,
      s.escrow.applicationId,
      s.escrow.accountId,
      s.fundingCall?.amount ?? null,
      s.fundingCall?.issuedAt ?? null,
      s.fundingCall?.reference ?? null,
      s.notes,
    ],
  )
  for (const b of s.buyers) await insertBuyer(tx, id, b)
  for (const w of s.wires) await purchaseRepositories(tx, id).wire(w)
  return id
}
const insertBuyer = async (tx: Transaction, id: string, b: Buyer) => {
  await tx.query(
    `insert into purchase_buyers (purchase_id,id,name,committed,verification_status,check_id,flagged_at,hits,escalated_at,envelope_id,signed,signed_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      b.id,
      b.name,
      b.committed,
      b.verification.status,
      b.verification.checkId,
      b.verification.flaggedAt,
      b.verification.hits,
      b.verification.escalatedAt,
      b.agreement?.envelopeId ?? null,
      b.agreement?.signed ?? false,
      b.agreement?.signedAt ?? null,
    ],
  )
}
