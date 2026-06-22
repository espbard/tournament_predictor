interface UserAvatarProps {
  username: string;
  imageUrl?: string | null;
  iconColor?: string | null;
  className?: string;
  style?: React.CSSProperties;
}

export function UserAvatar({ username, imageUrl, iconColor, className = '', style }: UserAvatarProps) {
  if (imageUrl) {
    return <img src={imageUrl} alt={username} className={`object-cover ${className}`} style={style} />;
  }

  const initial = username.charAt(0).toUpperCase();
  const bg = iconColor ?? '#4b5563';

  return (
    <span
      className={`flex items-center justify-center rounded-full font-semibold text-white select-none ${className}`}
      style={{ backgroundColor: bg, containerType: 'size', ...style } as React.CSSProperties}
      aria-label={username}
    >
      <span style={{ fontSize: '45cqmin', lineHeight: 1 }}>{initial}</span>
    </span>
  );
}
