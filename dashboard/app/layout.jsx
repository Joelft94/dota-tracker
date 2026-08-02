import './globals.css';

export const metadata = {
  title: 'Dota Tracker',
  description: 'Match tracker and leaderboards for the friend group',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
