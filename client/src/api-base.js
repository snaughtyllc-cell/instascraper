const configuredApiUrl = process.env.REACT_APP_API_URL;

const API_URL = configuredApiUrl || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:4000');

export default API_URL;
