import { useRef, useState } from 'react';
import { uploadFile } from '@/lib/api';

interface Props {
  type: 'users' | 'tournaments' | 'teams' | 'competitions';
  currentUrl?: string | null;
  onUploaded: (url: string) => void;
  shape?: 'circle' | 'square';
  label?: string;
}

export default function ImageUpload({ type, currentUrl, onUploaded, shape = 'square', label = 'Upload image' }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const displayUrl = preview ?? currentUrl ?? null;
  const shapeClass = shape === 'circle' ? 'rounded-full' : 'rounded-lg';

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setPreview(URL.createObjectURL(file));
    setError('');
    setUploading(true);
    try {
      const url = await uploadFile(file, type);
      onUploaded(url);
    } catch (err: any) {
      setError(err.message ?? 'Upload failed');
      setPreview(null);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {displayUrl ? (
        <img
          src={displayUrl}
          alt="Preview"
          className={`h-20 w-20 object-cover border ${shapeClass}`}
        />
      ) : (
        <div
          className={`flex h-20 w-20 items-center justify-center border-2 border-dashed border-border bg-muted text-muted-foreground text-xs ${shapeClass}`}
        >
          No image
        </div>
      )}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
      >
        {uploading ? 'Uploading…' : label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        className="hidden"
        onChange={handleChange}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
