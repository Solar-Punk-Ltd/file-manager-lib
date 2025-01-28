# TODO

This script uploads a directory structure to the Bee network using Mantaray as a manifest node. It lists files, saves a manifest, and allows downloading files.

## Prerequisites

1. **Node.js**: Ensure you have Node.js installed.
2. **Bee Node**: Download and install the Bee node binary.
3. **Swarm CLI**: Install the Swarm CLI tool.
4. **Postage Stamp**: Use `swarm-cli` to buy a postage stamp for uploading files to the Bee network.

---

## Setup Instructions

### 1. Run the Bee Node in Development Mode

Start the Bee node with the `--dev` flag to enable developer mode:

```bash
bee dev --cors-allowed-origins="*"
```

### 2. Install Dependencies

Clone this repository and navigate to the directory:

```bash
git clone https://github.com/Solar-Punk-Ltd/file-manager-lib
cd file-manager-lib
```

### 3. Buy Postage Stamp and Replace the id in index.ts

#### **Step 1: Install `swarm-cli`**
```bash
npm install -g @ethersphere/swarm-cli
```

#### **Step 2: List Existing Stamps**
Check if you have any active postage stamps:
```bash
swarm-cli stamp list
```

#### **Step 3: Buy a New Stamp**
If no stamps exist or you want to purchase a new one, run the following command:
```bash
swarm-cli stamp buy --amount 100000000000 --depth 20
```

Example Output:
```bash
Batch ID: c0598ec076f1a7222b9f074343c1009535e045cfa70e50aa34ca5c6b868a4daf
```

#### **Step 4: Replace stamp id in `index.ts`**
Replace batch id in the index.ts:
```bash
const STAMP = 'your-postage-stamp-id';
```

### 4. Run the Script

Run the script to upload the directory, generate a Mantaray manifest, list the files, and download the uploaded files:

```bash
npm run build
```

```bash
npm start
```

### 5. Troubleshooting
#### 1. **Manifest Not Found**
   - **Error:** You are unable to access files using the manifest reference URL.
   - **Solution:** Ensure that:
     - The manifest reference is correctly copied from the console output.
     - The Bee node is running and accessible at `http://localhost:1633`.

#### 2. **File Not Found**
   - **Error:** Specific files are not accessible even though the manifest reference is valid.
   - **Solution:** Verify that:
     - The directory structure (`nested-dir`) is correct and includes the expected files.
     - The files were properly uploaded and listed during the script's execution.

#### 3. **Postage Stamp Expired**
   - **Error:** Uploads fail due to insufficient funds or expired postage stamps.
   - **Solution:**
     - Purchase a new postage stamp using:
       ```bash
       curl -s -X POST http://localhost:1635/stamps/1000000/20
       ```
     - Update the `STAMP` constant in the script with the new postage stamp ID.

#### 4. **Permission Denied**
   - **Error:** Files or directories in `nested-dir` cannot be read.
   - **Solution:**
     - Ensure all files have read permissions:
       ```bash
       chmod -R 755 nested-dir
       ```

#### 5. **Bee Node Crashes or Becomes Unresponsive**
   - **Error:** The Bee node stops unexpectedly during the upload or download process.
   - **Solution:**
     - Restart the Bee node:
       ```bash
       bee dev --cors-allowed-origins="*"
       ```
     - Check the Bee node logs for errors and address any issues.


### 6. Further Enhancements
You can enhance the script by:
1. **Adding Metadata:**
   - Include additional metadata (e.g., timestamps or user-defined tags) for each file during the upload process.

2. **Dynamic Directory Selection:**
   - Allow users to dynamically select the directory to upload by adding a prompt or configuration setting.

3. **Batch Processing:**
   - Handle larger directories by implementing batch processing to upload files in chunks.

4. **UI Integration:**
   - Create a simple frontend interface to upload, list, and download files directly from the browser.

5. **Swarm Dashboard:**
   - Use a dashboard to monitor the Bee node's status, uploaded content, and active postage stamps.

6. **Postage Stamp Management:**
   - Build or integrate tools to manage and renew postage stamps efficiently.

Happy Swarming! 🐝