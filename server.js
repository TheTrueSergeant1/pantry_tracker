// --- FILE: server.js ---
// Node.js Express server for the PantryFlow Food Tracker application.
// Handles API routing, MySQL connection, and file uploads.

const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises; // <--- FIX IS HERE
const cors = require('cors');
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();

// --- CONFIGURATION ---
const app = express();
const PORT = process.env.SERVER_PORT || 8080;
const HOST = process.env.SERVER_HOST || '0.0.0.0'; // Listen on all interfaces

// MAMP MySQL Connection Configuration
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT // Typically 8889 for MAMP
};

// --- MIDDLEWARE SETUP ---

// Enable CORS for frontend communication
// Allowing all origins for local network testing (10.0.0.24)
app.use(cors());

// Parse URL-encoded bodies (form data) and JSON bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static files from the 'uploads' directory
// This allows the frontend to access images via /uploads/filename.jpg
const UPLOADS_DIR = path.join(__dirname, 'uploads');
app.use('/uploads', express.static(UPLOADS_DIR));

// Create uploads directory if it doesn't exist
fs.mkdir(UPLOADS_DIR, { recursive: true }).catch(err => console.error("Error creating uploads directory:", err));

// --- FILE UPLOAD (MULTER) CONFIGURATION ---

// Custom storage setup for handling file uploads and renaming
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        // Use a unique timestamp + original extension for robust naming
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

// Configure Multer for single file upload
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // Limit files to 5MB
});


// --- DATABASE CONNECTION POOL ---
let pool;

async function initDatabase() {
    try {
        pool = mysql.createPool(dbConfig);
        await pool.execute('SELECT 1'); // Test connection
        console.log('✅ MySQL Database connection successful.');
    } catch (error) {
        console.error('❌ FATAL: Failed to connect to MySQL Database.');
        console.error('Error Details:', error.message);
        // Do not start the server if the database connection fails
        process.exit(1); 
    }
}


// --- EXPIRATION CHECK AND REMINDER LOGIC ---

// This function runs periodically (or can be triggered by server start)
async function checkExpirationAndGenerateReminders() {
    const DAYS_THRESHOLD = 3;
    const ONE_MONTH_AGO = new Date();
    ONE_MONTH_AGO.setMonth(ONE_MONTH_AGO.getMonth() - 1);
    
    try {
        // 1. Delete closed reminders older than one month
        await pool.execute('DELETE FROM reminders WHERE is_closed = TRUE AND created_at < ?', [ONE_MONTH_AGO]);

        // 2. Fetch items expiring soon or already expired
        const [expiringItems] = await pool.execute(
            `SELECT id, name, best_by_date FROM items WHERE DATEDIFF(best_by_date, CURDATE()) <= ?`,
            [DAYS_THRESHOLD]
        );

        const reminderPromises = expiringItems.map(async (item) => {
            const bestBy = new Date(item.best_by_date);
            const diffDays = Math.ceil((bestBy.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
            
            let message;
            if (diffDays < 0) {
                message = `🚨 ALERT: ${item.name} is PAST its best-by date (${item.best_by_date.toISOString().split('T')[0]}).`;
            } else if (diffDays === 0) {
                message = `⚠️ WARNING: ${item.name} expires TODAY!`;
            } else {
                message = `⚠️ WARNING: ${item.name} expires in ${diffDays} day(s).`;
            }

            // Check if an active reminder already exists for this item/message
            const [existingReminders] = await pool.execute(
                'SELECT id FROM reminders WHERE item_id = ? AND message = ? AND is_closed = FALSE',
                [item.id, message]
            );

            if (existingReminders.length === 0) {
                // Insert new reminder
                await pool.execute(
                    'INSERT INTO reminders (item_id, item_name, message) VALUES (?, ?, ?)',
                    [item.id, item.name, message]
                );
            }
        });

        await Promise.all(reminderPromises);
        // console.log(`Reminder check completed. ${expiringItems.length} items checked.`);
    } catch (error) {
        console.error('Error in expiration check/reminder logic:', error);
    }
}


// --- PRICE HISTORY LOGIC ---

async function logPriceHistory(name, brand, price, purchase_date) {
    if (parseFloat(price) <= 0) return; // Only log actual prices
    
    // Ensure brand is null for database if empty string/undefined
    const dbBrand = (brand === undefined || brand === '') ? null : brand;

    try {
        await pool.execute(
            `INSERT INTO price_history (item_name, item_brand, price, recorded_at) 
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE price = VALUES(price)`, // If date/name/brand match, just update the price
            [name, dbBrand, parseFloat(price), purchase_date]
        );
    } catch (error) {
        // This is non-critical, so log and continue
        console.error('Error logging price history:', error.message);
    }
}


// --- API ROUTES ---

// GET: Home Page Route (for accessing index.html)
app.get('/pantry', (req, res) => {
    console.log('Frontend requested /pantry');
    res.sendFile(path.join(__dirname, 'index.html'));
});


// GET: Retrieve all items
app.get('/api/items', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM items ORDER BY id DESC');
        res.json(rows);
    } catch (error) {
        console.error('Error fetching items:', error);
        res.status(500).json({ error: 'Failed to fetch items' });
    }
});


// POST: Add a new item
app.post('/api/items', upload.single('image'), async (req, res) => {
    try {
        const { name, brand, location, purchase_date, best_by_date } = req.body;
        // Ensure price is saved as decimal or defaults to 0.00
        const price = parseFloat(req.body.price) || 0.00; 
        
        // Multer stores file info in req.file
        const imagePath = req.file ? `/uploads/${req.file.filename}` : null;
        
        // Ensure null is used for DB if brand is empty string or undefined
        const dbBrand = (brand === undefined || brand === '') ? null : brand;

        if (!name || !location || !purchase_date || !best_by_date) {
            // Clean up uploaded file if validation fails
            if (req.file) await fs.unlink(req.file.path); 
            return res.status(400).json({ error: 'Missing required fields (Name, Location, Dates).' });
        }

        const [result] = await pool.execute(
            'INSERT INTO items (name, brand, location, purchase_date, best_by_date, price, image_path) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, dbBrand, location, purchase_date, best_by_date, price, imagePath]
        );

        // LOG PRICE HISTORY
        await logPriceHistory(name, dbBrand, price, purchase_date);

        // Rerun the check to immediately update reminders if the new item is expiring soon
        await checkExpirationAndGenerateReminders(); 

        res.status(201).json({ 
            id: result.insertId,
            message: 'Item added successfully', 
            image_path: imagePath 
        });

    } catch (error) {
        console.error('Error adding item:', error);
        // Clean up uploaded file in case of DB error
        if (req.file) await fs.unlink(req.file.path); 
        res.status(500).json({ error: 'Failed to add item to database.' });
    }
});


// PUT: Update an existing item
app.put('/api/items/:id', upload.single('image'), async (req, res) => {
    const itemId = req.params.id;
    try {
        const { name, brand, location, purchase_date, best_by_date } = req.body;
        const price = parseFloat(req.body.price) || 0.00;
        const currentImagePath = req.body.current_image_path; // Hidden field value
        
        // Ensure null is used for DB if brand is empty string or undefined
        const dbBrand = (brand === undefined || brand === '') ? null : brand;
        
        let newImagePath = currentImagePath;
        let fileToDelete = null;

        // 1. Handle New Image Upload
        if (req.file) {
            // New file uploaded, so the old one needs to be deleted
            if (currentImagePath && currentImagePath !== 'DELETE_FLAG') {
                fileToDelete = path.join(__dirname, currentImagePath);
            }
            newImagePath = `/uploads/${req.file.filename}`;
        } 
        
        // 2. Handle Manual Image Deletion
        else if (currentImagePath === 'DELETE_FLAG') {
            // User manually clicked "Remove Image" in the modal
            if (currentImagePath) {
                 // Fetch current path from DB to delete the physical file
                const [rows] = await pool.execute('SELECT image_path FROM items WHERE id = ?', [itemId]);
                if (rows.length && rows[0].image_path) {
                    fileToDelete = path.join(__dirname, rows[0].image_path);
                }
            }
            newImagePath = null;
        }

        if (!name || !location || !purchase_date || !best_by_date) {
            return res.status(400).json({ error: 'Missing required fields (Name, Location, Dates).' });
        }

        const [result] = await pool.execute(
            'UPDATE items SET name=?, brand=?, location=?, purchase_date=?, best_by_date=?, price=?, image_path=? WHERE id=?',
            [name, dbBrand, location, purchase_date, best_by_date, price, newImagePath, itemId]
        );

        // Delete the old physical file if necessary
        if (fileToDelete) {
            await fs.unlink(fileToDelete).catch(err => console.error(`Failed to delete old image file: ${fileToDelete}`, err));
        }
        
        // LOG PRICE HISTORY
        await logPriceHistory(name, dbBrand, price, purchase_date);

        // Rerun the check to immediately update reminders based on new best_by_date
        await checkExpirationAndGenerateReminders();

        res.json({ message: 'Item updated successfully', image_path: newImagePath });

    } catch (error) {
        console.error('Error updating item:', error);
        // Clean up the newly uploaded file if DB update fails
        if (req.file) await fs.unlink(req.file.path);
        res.status(500).json({ error: 'Failed to update item in database.' });
    }
});


// DELETE: Delete an item
app.delete('/api/items/:id', async (req, res) => {
    const itemId = req.params.id;
    try {
        // Find image path before deletion
        const [rows] = await pool.execute('SELECT image_path FROM items WHERE id = ?', [itemId]);
        const imagePath = rows.length ? rows[0].image_path : null;

        // The ON DELETE CASCADE constraint in the DB schema will delete related reminders
        const [result] = await pool.execute('DELETE FROM items WHERE id = ?', [itemId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }

        // Delete the physical image file
        if (imagePath) {
            const fullPath = path.join(__dirname, imagePath);
            await fs.unlink(fullPath).catch(err => console.error(`Failed to delete physical image file: ${fullPath}`, err));
        }

        res.json({ message: 'Item deleted successfully' });
    } catch (error) {
        console.error('Error deleting item:', error);
        res.status(500).json({ error: 'Failed to delete item' });
    }
});


// --- REMINDER ROUTES ---

// GET: Retrieve all active and closed reminders
app.get('/api/reminders', async (req, res) => {
    try {
        const [active] = await pool.execute('SELECT * FROM reminders WHERE is_closed = FALSE ORDER BY created_at ASC');
        const [closed] = await pool.execute('SELECT * FROM reminders WHERE is_closed = TRUE ORDER BY created_at DESC');
        res.json({ active, closed });
    } catch (error) {
        console.error('Error fetching reminders:', error);
        res.status(500).json({ error: 'Failed to fetch reminders' });
    }
});

// PUT: Close an urgent notification (reminder)
app.put('/api/reminders/close/:id', async (req, res) => {
    const reminderId = req.params.id;
    try {
        const [result] = await pool.execute('UPDATE reminders SET is_closed = TRUE WHERE id = ?', [reminderId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Reminder not found' });
        }
        res.json({ message: 'Reminder closed successfully' });
    } catch (error) {
        console.error('Error closing reminder:', error);
        res.status(500).json({ error: 'Failed to close reminder' });
    }
});

// DELETE: Manually delete a single active notification
app.delete('/api/reminders/active/:id', async (req, res) => {
    const reminderId = req.params.id;
    try {
        const [result] = await pool.execute('DELETE FROM reminders WHERE id = ? AND is_closed = FALSE', [reminderId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Active reminder not found' });
        }
        res.json({ message: 'Active reminder deleted successfully' });
    } catch (error) {
        console.error('Error deleting active reminder:', error);
        res.status(500).json({ error: 'Failed to delete active reminder' });
    }
});

// DELETE: Clear all closed history (reminders)
app.delete('/api/reminders/closed/clear', async (req, res) => {
    try {
        await pool.execute('DELETE FROM reminders WHERE is_closed = TRUE');
        res.json({ message: 'Closed reminder history cleared successfully' });
    } catch (error) {
        console.error('Error clearing closed reminders:', error);
        res.status(500).json({ error: 'Failed to clear closed reminder history' });
    }
});


// --- DASHBOARD STATS ROUTE (FIXED) ---

app.get('/api/stats/spending', async (req, res) => {
    const { period } = req.query; // e.g., 'week', 'month', 'year', 'all'
    
    let dateFilterClause = ''; // SQL fragment for filtering by date column
    
    switch (period) {
        case 'week':
            dateFilterClause = 'WHERE ph.recorded_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
            break;
        case 'month':
            dateFilterClause = 'WHERE ph.recorded_at >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)';
            break;
        case 'year':
            dateFilterClause = 'WHERE ph.recorded_at >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)';
            break;
        case 'annual': 
            // Query price_history grouped by year
            try {
                const [annualResults] = await pool.execute(`
                    SELECT 
                        YEAR(recorded_at) AS year, 
                        SUM(price) AS total_spent 
                    FROM price_history
                    GROUP BY year
                    ORDER BY year DESC
                `);
                // Use a separate return for 'annual' as it has a different structure
                return res.json({ annualSummary: annualResults });
            } catch (error) {
                console.error('Error fetching annual spending stats:', error);
                return res.status(500).json({ error: 'Failed to fetch annual spending stats' });
            }
        case 'all': // Default: all time
        default:
            dateFilterClause = '';
            break;
    }

    try {
        // **Part 1: Calculate Total Spent (using the correct, immutable `price_history` table)**
        // This gives the total for the selected period regardless of current inventory status.
        const [totalResults] = await pool.execute(`
            SELECT SUM(price) AS totalSpent
            FROM price_history ph
            ${dateFilterClause}
        `);
        
        const totalSpent = parseFloat(totalResults[0]?.totalSpent || 0);

        // **Part 2: Calculate Location Breakdown (using the `items` table, as it has location)**
        // This calculates the *value of currently held inventory* within the date range.
        let locationFilterClause = '';
        if (period !== 'all') {
             // For period filters (week, month, year), we filter items by purchase date
             locationFilterClause = dateFilterClause.replace('ph.recorded_at', 'purchase_date');
             // Remove the initial 'WHERE' for the subquery logic below, and prepend with 'AND'
             locationFilterClause = locationFilterClause.replace('WHERE ', ' AND ');
        }
        
        const [locationResults] = await pool.execute(`
            SELECT
                SUM(CASE WHEN location = 'Pantry' THEN price ELSE 0 END) AS pantrySpent,
                SUM(CASE WHEN location = 'Fridge' THEN price ELSE 0 END) AS fridgeSpent,
                SUM(CASE WHEN location = 'Freezer' THEN price ELSE 0 END) AS freezerSpent
            FROM items i
            WHERE i.price > 0
            ${locationFilterClause}
        `);
        
        const locationStats = locationResults[0] || { pantrySpent: 0, fridgeSpent: 0, freezerSpent: 0 };


        res.json({ 
            // Use the correct total from the immutable purchase log
            totalSpent: totalSpent,
            // Use the location breakdown from the current inventory (best possible data)
            pantrySpent: parseFloat(locationStats.pantrySpent || 0),
            fridgeSpent: parseFloat(locationStats.fridgeSpent || 0),
            freezerSpent: parseFloat(locationStats.freezerSpent || 0),
        });

    } catch (error) {
        console.error('Error fetching spending stats:', error);
        res.status(500).json({ error: 'Failed to fetch spending statistics' });
    }
});


// --- PRICE TRACKER ROUTES ---

// GET: Get unique item names/brands for dropdown selectors
app.get('/api/price-tracker/unique-items', async (req, res) => {
    try {
        const [items] = await pool.execute(`
            SELECT DISTINCT item_name, item_brand
            FROM price_history
            ORDER BY item_name ASC, item_brand ASC
        `);
        res.json(items);
    } catch (error) {
        console.error('Error fetching unique items:', error);
        res.status(500).json({ error: 'Failed to fetch unique items for tracker' });
    }
});

// GET: Calculate price difference between two dates for a specific item
app.get('/api/price-tracker/difference', async (req, res) => {
    const { name, brand: brandQuery, startDate, endDate } = req.query;

    if (!name || !startDate || !endDate) {
        return res.status(400).json({ error: 'Missing required parameters (Item, Start Date, End Date).' });
    }
    
    // Normalize brand: frontend sends a string "null" if no brand was selected.
    let brand = brandQuery;
    if (brand === 'null' || brand === '') {
        brand = null;
    }
    
    // Helper function to find the price closest to a given date (on or before)
    const findClosestPrice = async (targetDate) => {
        // Find the latest price recorded on or before the target date.
        // The <=> operator handles the brand field correctly, even if it's NULL.
        const query = `
            SELECT price, recorded_at
            FROM price_history
            WHERE item_name = ? 
            AND item_brand <=> ?
            AND recorded_at <= ?
            ORDER BY recorded_at DESC
            LIMIT 1
        `;
        // Ensure the brand parameter sent to MySQL is null if no brand, not a string "null"
        const dbBrand = (brand === 'null' || brand === '') ? null : brand;
        
        const [rows] = await pool.execute(query, [name, dbBrand, targetDate]);
        return rows.length > 0 ? rows[0] : null;
    };

    try {
        const priceStart = await findClosestPrice(startDate);
        const priceEnd = await findClosestPrice(endDate);

        if (!priceStart) {
            return res.status(404).json({ error: `No price history found for '${name}' on or before start date (${startDate}).` });
        }
        if (!priceEnd) {
            return res.status(404).json({ error: `No price history found for '${name}' on or before end date (${endDate}).` });
        }

        const startPrice = parseFloat(priceStart.price);
        const endPrice = parseFloat(priceEnd.price);
        const difference = endPrice - startPrice;
        
        res.json({
            name,
            brand: brand,
            startDate: priceStart.recorded_at, // Use the actual date recorded
            endDate: priceEnd.recorded_at,   // Use the actual date recorded
            startPrice: startPrice,
            endPrice: endPrice,
            difference: difference
        });

    } catch (error) {
        console.error('Error calculating price difference:', error);
        res.status(500).json({ error: 'Failed to calculate price difference due to a server error.' });
    }
});


// --- SERVER STARTUP ---

async function startServer() {
    await initDatabase();
    
    // Run initial expiration check (and then once every hour)
    await checkExpirationAndGenerateReminders();
    setInterval(checkExpirationAndGenerateReminders, 60 * 60 * 1000); 

    app.listen(PORT, HOST, () => {
        console.log(`🎉 Server is running! Access the app at http://10.0.0.100:${PORT}/pantry`);
    });
}

startServer();