import { BrandMark } from "@/components/brand-mark";
import { LoginForm } from "./login-form";

// The logo's two accent shapes move while the phone number is being typed (see .login-stage in globals.css).
export default function LoginPage() {
  return (
    <div className="login-stage mx-auto flex w-full max-w-sm flex-col gap-4 pt-8">
      <BrandMark variant="page" className="login-brand mx-auto w-56" />
      <h1 className="font-display text-2xl font-bold">כניסה למערכת</h1>
      <p className="text-muted">הכניסה עם מספר הנייד שלך. נשלח אליך קוד חד-פעמי.</p>
      <section className="rounded-xl border border-line bg-surface p-4">
        <LoginForm />
      </section>
    </div>
  );
}
