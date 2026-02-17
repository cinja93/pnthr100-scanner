# PNTHR100 Scanner

Real-time stock scanner to find the top 100 highest YTD return stocks from S&P 500, NASDAQ 100, and Dow 30.

## Features

- Displays top 100 stock performers by Year-to-Date (YTD) return
- Sortable columns: Ticker Symbol, Exchange, Sector, Current Price, YTD Return
- Real-time data from Yahoo Finance
- Clean, modern UI with responsive design
- Auto-refresh capability with 5-minute server-side caching

## Prerequisites

You need to have Node.js installed on your system.

### Install Node.js

**Option 1: Using Homebrew (Recommended for macOS)**
```bash
brew install node
```

**Option 2: Download from official website**
Visit [https://nodejs.org](https://nodejs.org) and download the LTS version for your operating system.

## Installation

1. Navigate to the project directory:
```bash
cd "/Users/cindyeagar/PNTHR100 Scanner"
```

2. Install all dependencies (root, server, and client):
```bash
npm install
cd server && npm install
cd ../client && npm install
cd ..
```

## Running the Application

### Development Mode (Recommended)

Run both frontend and backend simultaneously:
```bash
npm run dev
```

This will start:
- Backend server at: `http://localhost:3000`
- Frontend app at: `http://localhost:5173`

### Manual Start (Alternative)

Run backend and frontend separately in different terminal windows:

**Terminal 1 - Backend:**
```bash
cd server
npm run dev
```

**Terminal 2 - Frontend:**
```bash
cd client
npm run dev
```

## Accessing the Application

1. Open your browser
2. Navigate to: `http://localhost:5173`
3. The app will automatically fetch and display the top 100 stocks

## Using the Scanner

- **Click any column header** to sort by that column
- **Click the same header again** to reverse the sort order
- **Click the Refresh button** to fetch the latest data
- Data is cached for 5 minutes on the server to reduce API load

## Project Structure

```
PNTHR100 Scanner/
├── server/                  # Backend Express server
│   ├── index.js            # Server entry point
│   ├── stockService.js     # Yahoo Finance integration
│   └── constituents.js     # Stock ticker lists
├── client/                  # React frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── StockTable.jsx
│   │   │   └── StockTable.module.css
│   │   ├── services/
│   │   │   └── api.js
│   │   ├── App.jsx
│   │   ├── App.css
│   │   └── main.jsx
│   ├── index.html
│   └── vite.config.js
└── package.json            # Root package.json
```

## Technology Stack

- **Frontend:** React 18, Vite
- **Backend:** Node.js, Express
- **Data Source:** Yahoo Finance (via yahoo-finance2)
- **Styling:** CSS Modules

## Notes

- Initial data load may take 30-60 seconds as it fetches data for ~630 unique stocks
- The app uses Yahoo Finance's free tier (no API key required)
- Data is cached server-side for 5 minutes to improve performance
- Stock lists include representative samples from S&P 500, NASDAQ 100, and Dow 30

## Troubleshooting

**Port already in use:**
If port 3000 or 5173 is already in use, you can modify the ports in:
- Backend: `server/index.js` (line 5)
- Frontend: `client/vite.config.js` (line 6)

**Data not loading:**
- Check that both frontend and backend servers are running
- Check the browser console and server logs for errors
- Ensure you have an active internet connection (required for Yahoo Finance API)

## Future Enhancements

- Real-time updates via WebSocket
- Additional filters (by sector, exchange, price range)
- Export to CSV functionality
- Historical charts for each stock
- Search/filter within results
- Mobile app version
