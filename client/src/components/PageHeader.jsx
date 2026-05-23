import styles from './PageHeader.module.css';
import pnthrFundsLogo from '../assets/PNTHR FUNDS Logo black background 2 lines.png';

export default function PageHeader({ title, description }) {
  return (
    <div className={styles.header}>
      <img src={pnthrFundsLogo} alt="PNTHR FUNDS" className={styles.logo} />
      <div className={styles.textBlock}>
        <h1 className={styles.title}>{title}</h1>
        {description && <p className={styles.description}>{description}</p>}
      </div>
    </div>
  );
}
