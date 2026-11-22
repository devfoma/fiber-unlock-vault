import './globals.css';

export const metadata = {
  title: 'Fiber Unlock Vault',
  description: 'Pay-to-unlock files and research briefs with Fiber on CKB Testnet.',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
