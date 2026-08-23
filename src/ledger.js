export function cents(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error("Enter an amount greater than zero.");
  return Math.round(number * 100);
}

export function formatCents(value, currency = "USD") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value / 100);
}

export function makeExpense({ description, amount, payerId, splits, createdAt = new Date().toISOString() }) {
  if (!description.trim()) throw new Error("Enter a description.");
  if (!payerId || !splits.length) throw new Error("Choose payer and at least one participant.");
  if (!Number.isInteger(amount) || amount <= 0 || splits.some((split) => !split.personId || !Number.isInteger(split.amount) || split.amount <= 0)) throw new Error("Expense amounts must be positive whole cents.");
  if (splits.reduce((sum, split) => sum + split.amount, 0) !== amount) throw new Error("Splits must equal total amount.");
  return { id: crypto.randomUUID(), type: "expense-created", description: description.trim(), amount, payerId, splits, createdAt };
}

export function balances(events, people) {
  const result = Object.fromEntries(people.map((person) => [person.id, 0]));
  for (const event of events) {
    if (event.type !== "expense" && event.type !== "expense-created") continue;
    result[event.payerId] = (result[event.payerId] || 0) + event.amount;
    for (const split of event.splits) result[split.personId] = (result[split.personId] || 0) - split.amount;
  }
  return result;
}

export function settlementPlan(balanceMap) {
  const debtors = Object.entries(balanceMap).filter(([, value]) => value < 0).map(([id, value]) => ({ id, value: -value }));
  const creditors = Object.entries(balanceMap).filter(([, value]) => value > 0).map(([id, value]) => ({ id, value }));
  const transfers = [];
  let debtor = 0;
  let creditor = 0;
  while (debtors[debtor] && creditors[creditor]) {
    const amount = Math.min(debtors[debtor].value, creditors[creditor].value);
    transfers.push({ from: debtors[debtor].id, to: creditors[creditor].id, amount });
    debtors[debtor].value -= amount;
    creditors[creditor].value -= amount;
    if (!debtors[debtor].value) debtor++;
    if (!creditors[creditor].value) creditor++;
  }
  return transfers;
}
