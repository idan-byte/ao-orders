// Roles and what each may do. Checked on the server for every screen and every action.
// Hiding a button in the UI is never the protection.

export const ROLES = {
  admin: "מנהל מערכת",
  company_manager: "מנהל חברה",
  sales: "מכירות ושירות לקוחות",
  order_clerk: "עובד הזמנות",
  dept_manager: "מנהל מחלקת ייצור",
  production_worker: "עובד ייצור",
  shipping_manager: "מנהל שילוח",
  loading_manager: "מנהל העמסה",
  driver: "נהג",
  customer: "לקוח חיצוני",
} as const;
export type Role = keyof typeof ROLES;

export const PERMISSIONS = [
  "dashboard.view",
  "catalog.view",
  "catalog.edit",
  "customers.view",
  "customers.edit",
  "prices.view",
  "prices.edit",
  "leads.view",
  "leads.edit",
  "quotes.view",
  "quotes.edit",
  "quotes.approve",
  "orders.view",
  "orders.edit",
  "orders.cancel",
  "orders.change_locked",
  "production.view",
  "production.mark",
  "production.lock",
  "shipping.view",
  "shipping.ship",
  "users.manage",
  "sync.run",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;
const without = (...drop: Permission[]) => ALL.filter((p) => !drop.includes(p));

// Production and shipping roles never get prices.view: prices stay hidden on their screens and documents.
const MATRIX: Record<Role, readonly Permission[]> = {
  admin: ALL,
  company_manager: without("users.manage"),
  sales: ["dashboard.view", "leads.view", "leads.edit", "catalog.view", "customers.view", "customers.edit", "prices.view", "prices.edit", "quotes.view", "quotes.edit", "quotes.approve", "orders.view", "orders.edit"],
  order_clerk: ["dashboard.view", "leads.view", "catalog.view", "customers.view", "prices.view", "quotes.view", "orders.view", "orders.edit"],
  dept_manager: ["dashboard.view", "catalog.view", "orders.view", "production.view", "production.mark", "production.lock"],
  production_worker: ["production.view", "production.mark"],
  shipping_manager: ["dashboard.view", "orders.view", "shipping.view", "shipping.ship"],
  loading_manager: ["shipping.view", "shipping.ship"],
  driver: ["shipping.view", "shipping.ship"],
  customer: [], // the customer portal has its own screens and sees only its own organisation
};

export function isRole(value: string): value is Role {
  return Object.hasOwn(ROLES, value);
}

export function can(role: string, permission: Permission): boolean {
  return isRole(role) && MATRIX[role].includes(permission);
}

/** Roles that must be attached to a production department. */
export const DEPARTMENT_ROLES: readonly Role[] = ["dept_manager", "production_worker"];
