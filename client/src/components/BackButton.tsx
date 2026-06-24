import { Link } from 'react-router-dom';

const cls = 'mb-4 inline-flex items-center justify-center opacity-50 hover:opacity-100 dark:opacity-60 dark:hover:opacity-100 transition-opacity';

export default function BackButton({ href, onClick }: { href?: string; onClick?: () => void }) {
  const content = <img src="/back-arrow.png" className="h-5 dark:invert dark:brightness-200" alt="" />;
  if (href) return <Link to={href} className={cls} aria-label="Go back">{content}</Link>;
  return <button type="button" onClick={onClick} className={cls} aria-label="Go back">{content}</button>;
}
