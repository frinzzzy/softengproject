async function runTest() {
    try {
        console.log("1. Gumagawa o nag-i-login ng test user para kumuha ng token...");
        
        // Subukan munang mag-register ng test account
        const regRes = await fetch('http://localhost:5000/api/v1/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'testcashier',
                password: 'password123',
                role: 'CASHIER'
            })
        });

        const regData = await regRes.json();
        let token = regData.token || regData.data?.token;

        // Kung sakaling naka-register na yan dati, mag-login na lang para makuha ang token
        if (!token) {
            const loginRes = await fetch('http://localhost:5000/api/v1/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: 'testcashier',
                    password: 'password123'
                })
            });
            const loginData = await loginRes.json();
            token = loginData.token || loginData.data?.token;
        }

        if (!token) {
            console.error('❌ Hindi makakuha ng token:', regData);
            return;
        }

        console.log('✅ Token nakuha nang matagumpay!');

        console.log("2. Pinapadala ang payment request...");
        const payRes = await fetch('http://localhost:5000/api/v1/orders/1/pay', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                payment_method: 'CASH',
                amount_paid: 1000.00,
                discount_type: 'SENIOR_CITIZEN',
                customer_name: 'Maria Santos',
                id_number: 'SC-987654321'
            })
        });

        const payData = await payRes.json();
        console.log('🚀 Server Response:', payData);

    } catch (error) {
        console.error('❌ Error during test:', error);
    }
}

runTest();