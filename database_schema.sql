-- 1. DATABASE CREATION
-- Creates the database if it doesn't already exist.
CREATE DATABASE IF NOT EXISTS food_tracker;

-- Selects the newly created database for subsequent commands
USE food_tracker;

-- 2. TABLE CREATION: items
-- Stores the main inventory items for Pantry, Fridge, and Freezer
CREATE TABLE items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    brand VARCHAR(255),
    -- Location must be one of the specified types
    location ENUM('Pantry', 'Fridge', 'Freezer') NOT NULL,
    purchase_date DATE NOT NULL,
    best_by_date DATE NOT NULL,
    -- Price defaults to 0.00 if user does not enter a value
    price DECIMAL(10, 2) DEFAULT 0.00,
    image_path VARCHAR(500), -- Stores the relative path to the image file
    is_spoiled BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. TABLE CREATION: reminders
-- Stores notifications for expiring or expired food, and closed reminders
CREATE TABLE reminders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    item_id INT,
    item_name VARCHAR(255) NOT NULL,
    message VARCHAR(500) NOT NULL,
    is_closed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- If the related item is deleted, the reminder is automatically deleted (CASCADE)
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE TABLE price_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    item_name VARCHAR(255) NOT NULL,
    item_brand VARCHAR(255),
    price DECIMAL(10, 2) NOT NULL,
    recorded_at DATE NOT NULL, -- Uses the item's purchase_date for the log
    -- This index prevents duplicate log entries if an item is edited on the same day without a price change
    UNIQUE KEY unique_price_entry (item_name, item_brand, recorded_at)
);