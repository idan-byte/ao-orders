export function NoAccess() {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="font-display text-2xl font-bold">אין הרשאה למסך הזה</h1>
      <p className="text-muted">התפקיד שלך אינו כולל גישה למסך הזה. אם זו טעות, מנהל המערכת יכול לעדכן את התפקיד במסך המשתמשים.</p>
    </div>
  );
}
