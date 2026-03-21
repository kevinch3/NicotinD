import { useId, useState, type InputHTMLAttributes } from 'react';

type PasswordFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  inputClassName?: string;
};

export function PasswordField({
  inputClassName = '',
  id,
  className = '',
  autoComplete = 'current-password',
  ...props
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className={`relative ${className}`}>
      <input
        {...props}
        id={inputId}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        className={`w-full pr-16 ${inputClassName}`}
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-medium text-zinc-400 transition hover:text-zinc-100 hover:bg-zinc-700/60 focus:outline-none focus:ring-1 focus:ring-zinc-500"
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
