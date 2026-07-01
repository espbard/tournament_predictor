import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

const cls =
  'mb-4 hidden sm:inline-flex items-center justify-center h-9 w-9 rounded-full border border-border bg-card text-foreground/70 shadow-sm transition-all hover:text-foreground hover:border-foreground/30 hover:shadow-md active:scale-95';

export default function BackButton({ href, onClick }: { href?: string; onClick?: () => void }) {
  const content = <ArrowLeft size={18} strokeWidth={2.25} />;
  if (href) return <Link to={href} className={cls} aria-label="Go back">{content}</Link>;
  return <button type="button" onClick={onClick} className={cls} aria-label="Go back">{content}</button>;
}
