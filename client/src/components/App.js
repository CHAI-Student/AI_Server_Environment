import { Suspense } from 'react';
// import { Route, Switch } from "react-router-dom";
import { Routes, Route } from "react-router-dom";

// pages for this product
import LandingPage from './views/LandingPage/LandingPage';

function App() {

  const design = () => {
    if (window.location.href === 'http://localhost:3000/') {
      return <div style={{display: 'none'}}></div>
    } else {
      return <div style={{ paddingTop: '69px', minHeight: '120px', background: '#282828' }}></div>
    }
  }

  return (
      <Suspense fallback={(<div>Loading...</div>)}>
          {design()}
          <Routes>
            <Route path="/" element={<LandingPage />} />
          </Routes>
      </Suspense>
  );
}

export default App;