import "./Footer.css";

type FooterProps = {
  version: string;
};

export function Footer({ version }: FooterProps) {
  return (
    <footer className="footer">
      <span>Agent version {version}</span>
    </footer>
  );
}
