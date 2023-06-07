import { ReactNode, useState } from 'react';
import '../style/hamburger-menu.css';

export interface HamburgerMenuProps {
  children: ReactNode;
}

export const HamburgerMenu: React.FC<HamburgerMenuProps> = ({ children }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="qh-hamburger-menu">
      <input
        type="checkbox"
        checked={menuOpen}
        onClick={() => setMenuOpen(!menuOpen)}
        className="menu-toggle"
      />
      <div className={`menu-content ${menuOpen ? 'open' : 'closed'} `}>
        {children}
      </div>
    </div>
  );
};
