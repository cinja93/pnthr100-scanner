import { useState, useEffect } from 'react';
import styles from './ManageStocks.module.css';

const API_URL = 'http://localhost:3000/api';

export default function ManageStocks() {
  const [supplementalStocks, setSupplementalStocks] = useState([]);
  const [newTicker, setNewTicker] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ text: '', type: '' });

  // Fetch supplemental stocks on component mount
  useEffect(() => {
    fetchSupplementalStocks();
  }, []);

  const fetchSupplementalStocks = async () => {
    try {
      const response = await fetch(`${API_URL}/supplemental-stocks`);
      if (!response.ok) throw new Error('Failed to fetch');
      const data = await response.json();
      setSupplementalStocks(data);
    } catch (error) {
      showMessage('Failed to load supplemental stocks', 'error');
    }
  };

  const handleAddStock = async (e) => {
    e.preventDefault();

    if (!newTicker.trim()) {
      showMessage('Please enter a ticker symbol', 'error');
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/supplemental-stocks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ticker: newTicker.toUpperCase() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to add stock');
      }

      // Success - refresh list and clear input
      await fetchSupplementalStocks();
      setNewTicker('');
      showMessage(`Added ${data.ticker} successfully!`, 'success');
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveStock = async (ticker) => {
    if (!confirm(`Remove ${ticker} from supplemental list?`)) {
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/supplemental-stocks/${ticker}`, {
        method: 'DELETE',
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to remove stock');
      }

      // Success - refresh list
      await fetchSupplementalStocks();
      showMessage(`Removed ${ticker} successfully!`, 'success');
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const showMessage = (text, type) => {
    setMessage({ text, type });
    setTimeout(() => setMessage({ text: '', type: '' }), 3000);
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2>Manage Supplemental Stocks</h2>
        <p className={styles.subtitle}>
          Add additional stocks to scan beyond S&P 500, NASDAQ 100, and Dow 30
        </p>
      </div>

      {/* Add Stock Form */}
      <form className={styles.addForm} onSubmit={handleAddStock}>
        <input
          type="text"
          className={styles.input}
          placeholder="Enter ticker (e.g., AAPL)"
          value={newTicker}
          onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
          disabled={loading}
        />
        <button
          type="submit"
          className={styles.addButton}
          disabled={loading}
        >
          {loading ? 'Adding...' : 'Add Stock'}
        </button>
      </form>

      {/* Message Display */}
      {message.text && (
        <div className={`${styles.message} ${styles[message.type]}`}>
          {message.text}
        </div>
      )}

      {/* Stocks List */}
      <div className={styles.stocksList}>
        <div className={styles.listHeader}>
          <span className={styles.count}>
            {supplementalStocks.length} supplemental {supplementalStocks.length === 1 ? 'stock' : 'stocks'}
          </span>
        </div>

        {supplementalStocks.length === 0 ? (
          <div className={styles.emptyState}>
            <p>No supplemental stocks added yet.</p>
            <p className={styles.hint}>Add stocks above to expand your scan beyond the standard indexes.</p>
          </div>
        ) : (
          <div className={styles.grid}>
            {supplementalStocks.map((ticker) => (
              <div key={ticker} className={styles.stockChip}>
                <span className={styles.ticker}>{ticker}</span>
                <button
                  className={styles.removeButton}
                  onClick={() => handleRemoveStock(ticker)}
                  disabled={loading}
                  title={`Remove ${ticker}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
