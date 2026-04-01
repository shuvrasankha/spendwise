# SpendWise - Daily Expense Tracker

A modern, client-side expense tracking application built with vanilla JavaScript, Firebase, and Firestore. Track your daily spending with ease, visualize spending patterns, and manage your finances efficiently.

🌐 **Visit the app:** https://spendwise-sp.netlify.app

## Features

✨ **Core Features:**
- 📊 Real-time expense tracking with daily/weekly/monthly/yearly views
- 🔐 Secure authentication with Email/Password and Google Sign-In
- 💳 Multiple payment methods support
- 📝 Detailed expense logging (amount, category, date, payment method, notes)
- 📈 Interactive charts and spending analytics
- 📥 CSV export functionality for any time period
- 🌓 Dark/Light mode toggle
- 🔒 Client-side XOR encryption for sensitive fields
- 📱 Fully responsive design (mobile, tablet, desktop)

## Technologies Used

- **Frontend:** HTML5, CSS3, Vanilla JavaScript
- **Backend:** Firebase & Firestore (NoSQL database)
- **Authentication:** Firebase Auth (Email/Password, Google OAuth)
- **Charts:** Chart.js for data visualization
- **Icons:** Lucide Icons
- **Deployment:** Netlify
- **Encryption:** Client-side XOR encryption

### Manual Deployment
1. Build/prepare your files (already optimized for static hosting)
2. Drag and drop the folder into Netlify's deploy area
3. Configure environment variables if needed

## Usage

1. **Sign Up/Login:** Create an account with email or Google
2. **Add Expense:** Click the add button, fill in amount, category, date, payment method, and notes
3. **View Analytics:** Switch between Daily, Weekly, Monthly, and Yearly views
4. **Export Data:** Download your expenses as CSV for record-keeping
5. **Toggle Theme:** Use the dark/light mode toggle in settings

## File Structure

```
spendwise/
├── index.html          # Main HTML structure
├── app.js             # JavaScript logic & Firebase integration
├── style.css          # Styling and responsive design
├── netlify.toml       # Netlify configuration
└── README.md          # This file
```

## Security Considerations

- ✅ User data is stored securely in Firestore with user authentication
- ✅ Sensitive fields are encrypted client-side using XOR encryption
- ✅ Firestore rules restrict access to user's own data only
- ⚠️ Never commit Firebase credentials to public repositories (use environment variables in production)

## Browser Support

- Chrome/Edge (latest)
- Firefox (latest)
- Safari (latest)
- Mobile browsers (iOS Safari, Chrome Mobile)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Firebase is not defined" | Ensure Firebase scripts are loaded correctly in index.html |
| Authentication not working | Verify Firebase config credentials in app.js |
| Data not saving | Check Firestore security rules and database initialization |
| Styles not loading | Clear browser cache and reload |

## Future Enhancements

- Budget setting and alerts
- Receipt image uploads
- Recurring expense management
- Multi-currency support
- Advanced filtering and search
- Mobile app (PWA)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is open source and available under the MIT License.

## Contact & Support

For questions or issues, please open a GitHub issue or contact the maintainer.

---
**Last Updated:** March 2026
