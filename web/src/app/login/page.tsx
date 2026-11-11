import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-4 pt-8">
      <h1 className="font-display text-2xl font-bold">כניסה למערכת</h1>
      <p className="text-muted">הכניסה עם מספר הנייד שלך. נשלח אליך קוד חד-פעמי.</p>
      <section className="rounded-xl border border-line bg-surface p-4">
        <LoginForm />
      </section>
    </div>
  );
}
