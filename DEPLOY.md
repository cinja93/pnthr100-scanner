# Deploy PNTHR100 Scanner — Full step-by-step guide

This guide walks you through **every step** to get your app online so your husband (or anyone) can use it from any computer. No prior experience needed.

---

## Before you start

**You will need:**

1. **Your project folder** — `PNTHR100 Scanner` on your Mac (you have this).
2. **Your FMP API key** — You already have this in `server/.env` as `FMP_API_KEY`. We’ll use it again on Render.
3. **Your MongoDB connection string** — You already have this in `server/.env` as `MONGODB_URI`. We’ll use it on Render.
4. **A GitHub account** — Free. If you don’t have one: go to [github.com](https://github.com), click **Sign up**, and create an account.

**We’ll do these in order:**

- **Part 1:** Put your code on GitHub  
- **Part 2:** Check MongoDB Atlas (you already use it)  
- **Part 3:** Deploy the backend on Render  
- **Part 4:** Deploy the frontend on Vercel  
- **Part 5:** Test and share the link  

---

# Part 1 — Put your code on GitHub

GitHub will hold your code so Render and Vercel can use it.

## 1.1 Create a new repository on GitHub

1. Open your browser and go to **https://github.com**. Log in if needed.
2. In the top-right, click the **+** (plus) and choose **New repository**.
3. On the “Create a new repository” page:
   - **Repository name:** type `pnthr100-scanner` (or any name you like, no spaces).
   - **Description:** optional, e.g. `Stock scanner for long and short ideas`.
   - Leave **Public** selected.
   - **Do not** check “Add a README” or “Add .gitignore” — we’re uploading an existing project.
4. Click the green **Create repository** button.
5. You’ll see a page that says “Quick setup” and shows a URL like  
   `https://github.com/YOUR_USERNAME/pnthr100-scanner.git`.  
   Leave this page open; you’ll need that URL in the next part.

## 1.2 Put your project in Git and push to GitHub

We’ll do this in **Terminal** on your Mac.

1. Open **Terminal** (Applications → Utilities → Terminal, or search “Terminal” in Spotlight).
2. Go to your project folder. Type this and press Enter (use your real path if different):

   ```bash
   cd "/Users/cindyeagar/PNTHR100 Scanner"
   ```

3. Initialize Git (if this folder isn’t already a Git repo):

   ```bash
   git init
   ```

   You might see “Reinitialized existing Git repository” — that’s fine.

4. Create a `.gitignore` so we don’t upload secrets or junk:

   ```bash
   echo "node_modules
   server/node_modules
   client/node_modules
   server/.env
   .env
   .DS_Store
   dist" > .gitignore
   ```

   This keeps `server/.env` (your API key and MongoDB URL) off GitHub.

5. Add all files and make the first commit:

   ```bash
   git add .
   git commit -m "Initial commit - PNTHR100 Scanner"
   ```

6. Connect to GitHub and push. Replace `YOUR_USERNAME` and `pnthr100-scanner` with your repo name if different:

   ```bash
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/pnthr100-scanner.git
   git push -u origin main
   ```

   When it asks for your username and password: use your **GitHub username** and a **Personal Access Token**, not your normal GitHub password.  
   - To create a token: GitHub → your profile (top right) → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token**. Give it a name, check **repo**, then generate and copy the token. Paste it when Terminal asks for the password.

7. Refresh your GitHub repo page. You should see all your project folders (`client`, `server`, etc.). Part 1 is done.

---

# Part 2 — Check MongoDB Atlas

You already use MongoDB (your `server/.env` has `MONGODB_URI`). We only need to make sure the cloud server can reach it.

1. Go to **https://cloud.mongodb.com** and log in.
2. In the left sidebar click **Network Access**.
3. You should see at least one entry. If one of them says **0.0.0.0/0** (Allow access from anywhere), you’re good — skip to Part 3.
4. If not: click **Add IP Address**. Choose **Allow access from anywhere** (it will show 0.0.0.0/0). Click **Confirm**.  
   This lets Render’s servers connect to your database.

Keep your **MONGODB_URI** and **MONGODB_DB_NAME** from `server/.env` handy; you’ll paste them into Render in Part 3.

---

# Part 3 — Deploy the backend on Render

Render will run your Node server 24/7 so the app can get stock data from anywhere.

## 3.1 Sign up and create a Web Service

1. Go to **https://render.com** in your browser.
2. Click **Get Started for Free**.
3. Choose **Sign up with GitHub** and authorize Render to use your GitHub account.
4. After you’re in the Render dashboard, click the blue **New +** button (top right), then click **Web Service**.

## 3.2 Connect your GitHub repo

1. Under “Connect a repository” you’ll see a list of your GitHub repos. Find **pnthr100-scanner** (or whatever you named it) and click **Connect** next to it.  
   If you don’t see it, click **Configure account** and make sure Render has access to the repo that contains your project.
2. After you click **Connect**, the page will show settings for the new Web Service. Use these **exactly**:

   | Setting | What to choose or type |
   |--------|------------------------|
   | **Name** | `pnthr100-scanner-api` (or any name; this becomes part of the URL) |
   | **Region** | Pick the one closest to you (e.g. Oregon) |
   | **Branch** | `main` |
   | **Root Directory** | Click **Add** or the field and type: `server` |
   | **Runtime** | `Node` |
   | **Build Command** | `npm install` (use only this — do **not** add `npm run build`; the server has no build step) |
   | **Start Command** | `npm start` |
   | **Instance Type** | **Free** |

   **Important:** “Root Directory” must be `server` so Render runs the code in your `server` folder.

## 3.3 Add environment variables

1. Scroll down to **Environment Variables**.
2. Click **Add Environment Variable**. Add these **one by one** (name and value):

   | Name | Value (where to get it) |
   |------|------------------------|
   | `MONGODB_URI` | Copy the full line from your `server/.env` (starts with `mongodb+srv://...`). Paste here. |
   | `MONGODB_DB_NAME` | Type: `pnthr100` (or whatever is in your .env as MONGODB_DB_NAME) |
   | `FMP_API_KEY` | Copy from your `server/.env` (the value of FMP_API_KEY). Paste here. |
   | `API_KEY` | Copy from your `server/.env` (the value of API_KEY). This protects all API routes. |

   For each row: type the **Name** exactly (e.g. `MONGODB_URI`), paste or type the **Value**, then add the next variable. Don’t put quotes around the values.

3. When all three are there, scroll to the bottom and click the blue **Create Web Service** button.

## 3.4 Wait for the first deploy

1. Render will start building and then deploying. You’ll see logs in the middle of the page.
2. Wait until the top of the page shows a green **Live** badge (can take 2–5 minutes).
3. At the top you’ll see a URL like:  
   **https://pnthr100-scanner-api-xxxx.onrender.com**  
   (yours will have a different random part instead of `xxxx`.)
4. **Copy that full URL** and save it somewhere (e.g. a Notes app). This is your **API URL**. You’ll paste it into Vercel in Part 4. Do **not** add a slash at the end.

If the build fails, check the logs. Common fixes: **Root Directory** must be `server`, and all three environment variables must be set.

---

# Part 4 — Deploy the frontend on Vercel

Vercel will host the React app and give you one link to share with your husband and others.

## 4.1 Sign up and create a project

1. Go to **https://vercel.com** in your browser.
2. Click **Sign Up** and choose **Continue with GitHub**. Authorize Vercel.
3. After you’re in the dashboard, click **Add New…** (top right), then **Project**.

## 4.2 Import your repo

1. You’ll see “Import Git Repository”. Find **pnthr100-scanner** (same repo as before) and click **Import** next to it.
2. On the “Configure Project” page, set these:

   | Setting | What to choose or type |
   |--------|------------------------|
   | **Project Name** | Leave as is (e.g. pnthr100-scanner) or rename if you like |
   | **Root Directory** | Click **Edit**, then type: `client` and confirm. (So Vercel builds only the frontend.) |
   | **Framework Preset** | Should say **Vite**. If not, choose Vite. |
   | **Build Command** | Should be `npm run build`. Leave it. |
   | **Output Directory** | Should be `dist`. Leave it. |

## 4.3 Add the API URL and key (important)

1. Expand **Environment Variables**.
2. Add these two variables (click **Add** between each):

   | Name | Value |
   |------|-------|
   | `VITE_API_URL` | The Render URL from Part 3 (e.g. `https://pnthr100-scanner-api-xxxx.onrender.com`). No trailing slash. |
   | `VITE_API_KEY` | The same value as `API_KEY` in your `server/.env`. This lets the browser authenticate with the server. |

3. Leave the environment as **Production** (default).
4. Click the **Deploy** button.

## 4.4 Wait for the deploy

1. Vercel will build and deploy. Wait until you see **Congratulations!** and a link like **https://pnthr100-scanner-xxxx.vercel.app**.
2. **Use the app at** `https://pnthr100-scanner-xxxx.vercel.app/pnthr100/` (the path `/pnthr100/` is required). This is the **app URL** you give to your husband and others. Anyone who opens it can use the scanner from anywhere.

---

# Part 5 — Test and share

1. Open the **Vercel link** (the one that ends in `.vercel.app`) in your browser.
2. You should see your PNTHR100 Scanner: Scan Long / Scan Short, date dropdown, table.  
   - If the page loads but the table never fills: wait 30–60 seconds (free Render can “sleep”; the first request wakes it). Then refresh.  
   - If you see a network or CORS error in the browser, tell me and we can add one CORS setting on the server.
3. When it works, share **only the Vercel link** (e.g. `https://pnthr100-scanner-xxxx.vercel.app/pnthr100/`) with your husband or anyone else. They don’t need a GitHub, Render, or Vercel account — just the link.

---

# Part 6 — Custom domain (pnthrfunds.com/pnthr100)

The app is built to run at **/pnthr100/** so you can serve it at **https://pnthrfunds.com/pnthr100**.

## 6.1 Add the domain in Vercel

1. In the Vercel dashboard, open your **pnthr100-scanner** project.
2. Go to **Settings** → **Domains**.
3. Under "Add domain", type: **pnthrfunds.com** and click **Add**.
4. Vercel will show how to set up DNS. You need to add a record so that **pnthrfunds.com** points to Vercel (see 6.2).

## 6.2 Point your domain at Vercel (DNS)

Where you manage DNS for **pnthrfunds.com** (e.g. GoDaddy, Namecheap, Cloudflare, your registrar):

- If Vercel says to use **A records:** add the IPs Vercel shows (e.g. `76.76.21.21`) for the **root** host (sometimes called `@` or "apex").
- If Vercel says to use **CNAME:** add a CNAME for **www** (or the host they specify) to **cname.vercel-dns.com**.

After DNS is set, Vercel may take a few minutes to verify. When the domain shows a green check, the app will be at:

- **https://pnthrfunds.com/pnthr100/**

(Vercel's redirect in this project sends the root path to `/pnthr100/`.)

## 6.3 If pnthrfunds.com already has a different website

If the **root** of pnthrfunds.com is another site (e.g. WordPress, Squarespace) and you only want the scanner at **/pnthr100**:

- You **cannot** point the whole domain to Vercel without replacing that site.
- Use a **subdomain** instead: **pnthr100.pnthrfunds.com**. In Vercel → Settings → Domains, add **pnthr100.pnthrfunds.com**. In your DNS, add a **CNAME** for **pnthr100** to **cname.vercel-dns.com**. The app will be at **https://pnthr100.pnthrfunds.com/pnthr100/**.

---

# Quick reference

- **App link to share:** your Vercel URL (e.g. `https://pnthr100-scanner-xxxx.vercel.app/pnthr100/`) or custom URL (e.g. `https://pnthrfunds.com/pnthr100/`).
- **Backend (Render):** free tier may sleep after ~15 min of no use; first load after that can be slow, then normal.
- **Secrets:** Your `server/.env` stays only on your Mac; we never put it on GitHub. Render and Vercel get the same values as **environment variables** that you typed in.

---

# If something goes wrong

- **“Build failed” on Render:** Check that Root Directory is `server`, and that `MONGODB_URI`, `MONGODB_DB_NAME`, and `FMP_API_KEY` are all set under Environment Variables.
- **“Build failed” on Vercel:** Check that Root Directory is `client` and that `VITE_API_URL` is set to your Render URL (no trailing slash).
- **App loads but no data:** Wait a minute and refresh (Render might be waking). If it still fails, open the browser’s Developer Tools (right‑click → Inspect → Console) and tell me the exact error message.
- **Git push asks for password:** Use a GitHub **Personal Access Token** as the password, not your normal GitHub password.

If you tell me which part you’re on (e.g. “Part 1, I’m at the git push step”) and what you see on the screen, I can give you the next exact click or command.
