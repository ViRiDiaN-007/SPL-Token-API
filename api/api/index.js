const { Connection, Keypair, VersionedTransaction, SendTransactionError } = require('@solana/web3.js');
const solanaWeb3 = require('@solana/web3.js');
const fetch = require('cross-fetch');
const { Wallet } = require('@project-serum/anchor');
const bs58 = require('bs58');
const fs = require('fs');
const csv = require('csv-parser');
const express = require('express');
const ini = require('ini');
const app = express();
const port = 3000;
const {Transaction, ComputeBudgetProgram, PublicKey, sendAndConfirmTransaction } = require('@solana/web3.js');
const { Stream } = require('stream');

const config = ini.parse(fs.readFileSync('config.ini', 'utf-8'));
const CUSTOM_RPC_ENDPOINT = config.rpc.endpoint
const connection = new Connection(CUSTOM_RPC_ENDPOINT);
const private = config.wallets.private_key

const maxRetries = 5

function getKeypairFromSecretKey(secretKey) {
  const decodedKey = bs58.decode(secretKey);
  if (decodedKey.length !== 64) {
    throw new Error('Invalid secret key length. Expected 64 bytes.');
  }
  return Keypair.fromSecretKey(decodedKey);
}

const wallet = new Wallet(getKeypairFromSecretKey(private));
const referral = private ? new Wallet(getKeypairFromSecretKey(private)) : null;

async function createLimitOrder(inputMint, outputMint, inAmount, outAmount) {
  try {
    const computeUnitPriceMicroLamports = 2500000; // Increased priority fee

    inputMint = new PublicKey(inputMint);
    outputMint = new PublicKey(outputMint);

    if (!PublicKey.isOnCurve(inputMint) || !PublicKey.isOnCurve(outputMint)) {
      throw new Error('Invalid input or output mint address');
    }

    const balance = await connection.getBalance(wallet.publicKey);
    const requiredBalance = computeUnitPriceMicroLamports / 1_000_000; // Convert micro-lamports to SOL
    if (balance < requiredBalance) {
      throw new Error('Insufficient SOL balance for priority fee');
    }

    const base = Keypair.generate();

    const body = {
      owner: wallet.publicKey.toString(),
      inAmount,
      outAmount,
      inputMint: inputMint.toString(),
      outputMint: outputMint.toString(),
      base: base.publicKey.toString(), // Ensure base is included and is a string
      referralAccount: referral ? referral.publicKey.toString() : '', // Set to empty string if not provided
      referralName: referral ? "Referral Name" : '' // Set to empty string if not provided
    };

    const response = await fetch('https://jup.ag/api/limit/v1/createOrder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    console.log('Response status:', response.status);
    const responseBody = await response.text();

    if (!response.ok) {
      throw new Error('Failed to fetch transactions from the API');
    }

    const { tx } = JSON.parse(responseBody);
    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const priorityFeeInstruction = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: computeUnitPriceMicroLamports
    });

    if (!wallet.publicKey) {
      throw new Error('Payer key is undefined');
    }
    if (!recentBlockhash) {
      throw new Error('Recent blockhash is undefined');
    }
    if (!priorityFeeInstruction) {
      throw new Error('Priority fee instruction is undefined');
    }

    const transactionBuf = Buffer.from(tx, "base64");
    const transaction = Transaction.from(transactionBuf);

    transaction.add(priorityFeeInstruction);
    transaction.recentBlockhash = recentBlockhash;
    transaction.feePayer = wallet.publicKey;

    transaction.sign(wallet.payer, base);

    const rawTransaction = transaction.serialize();

    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 2,
    });

    console.log(`Transaction sent with txid: ${txid}`);
    console.log(`https://solscan.io/tx/${txid}`);

    // Wait for the transaction to be confirmed
    await connection.confirmTransaction(txid);
    console.log('Transaction confirmed!');

    return { txid, link: `https://solscan.io/tx/${txid}` };
  } catch (error) {
    throw new Error(error.message);
  }
}

const swapTokens = async (wallet, coin, amt, slippage) => {
  try {
    console.log(coin, amt, slippage);
    const quoteResponse = await (
      await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${coin}&amount=${amt}&slippageBps=${slippage}`)
    ).json();
      console.log(quoteResponse)
      const {
        inputMint,
        inAmount,
        outputMint,
        outAmount,
        otherAmountThreshold,
        swapMode,
        slippageBps,
        platformFee,
        priceImpactPct,
        routePlan,
        contextSlot,
        timeTaken
      } = quoteResponse;

      // Calculate cost basis
     const costBasis = (inAmount / outAmount) / 1000;
      console.log(`Cost Basis: ${costBasis}`);


    if (!quoteResponse) {
      throw new Error('Failed to fetch quote response');
    }

    const { swapTransaction } = await (
      await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 7000000
        })
      })
    ).json();
    /**
     * 
     * cost basis = (in / out)/100  .00000806
     * half amount = outAmount/2    1.241.210
     * limit order = cost basis * 
     */

    if (!swapTransaction) {
      throw new Error('Failed to fetch swap transaction');
    }

    // Function to fetch a recent blockhash and set it in the transaction
    const updateTransactionBlockhash = async (transaction) => {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      console.log(`Fetched blockhash: ${blockhash}`);
      console.log(`Fetched height: ${lastValidBlockHeight}`);
      transaction.recentBlockhash = blockhash; // Set the recent blockhash
      transaction.feePayer = wallet.publicKey; // Set the fee payer
      transaction.sign([wallet.payer]);
    };
 
    // First attempt to send the transaction
    try {
      const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
      await updateTransactionBlockhash(transaction);

      const rawTransaction = transaction.serialize();
      const txid = await connection.sendRawTransaction(rawTransaction, {


        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 5

      });
      let attempts = 0;
      while (attempts < maxRetries) {
        try {
          await connection.confirmTransaction((txid));
          console.log(`Buy Transaction successful: https://solscan.io/tx/${txid}`);
          return { txid, outAmount };
        }
        catch(error){
          attempts++;
          console.error(`Buy Attempt ${attempts} failed: ${error.message}`);

        }

    } 

      console.log(`Swap Transaction prob failed: https://solscan.io/tx/${txid}`);

      //return `Swap Transaction successful: https://solscan.io/tx/${txid}`;
      return { txid, outAmount };

    } catch (error) {
      if (error.message.includes('Blockhash not found')) {
        // Retry with a new blockhash
        console.log(error)
        console.warn('Retrying transaction with a new blockhash...');
        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        await updateTransactionBlockhash(transaction);

        const rawTransaction = transaction.serialize();
        const txid = await connection.sendRawTransaction(rawTransaction, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        maxRetries: 5
});
        await connection.confirmTransaction(txid);

        console.log(`Transaction successful: https://solscan.io/tx/${txid}`);
        //return `Swap Transaction successful: https://solscan.io/tx/${txid}`;
      return { txid, outAmount };
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Error during swapTokens:', error);

    if (error instanceof SendTransactionError) {
      console.error('Transaction Logs:', error.logs);
    }

    return `Error during swapTokens: ${error.message}`;
  }
};


const sellTokens = async (wallet, coin, amt, slippage) => {
  try {
    console.log(coin, amt, slippage);
    const quoteResponse = await (
      await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${coin}&outputMint=So11111111111111111111111111111111111111112&amount=${amt}&slippageBps=${slippage}`)
    ).json();
      console.log(quoteResponse)
      const {
        inputMint,
        inAmount,
        outputMint,
        outAmount,
        otherAmountThreshold,
        swapMode,
        slippageBps,
        platformFee,
        priceImpactPct,
        routePlan,
        contextSlot,
        timeTaken
      } = quoteResponse;

      // Calculate cost basis
     const costBasis = (inAmount / outAmount) / 1000;
      console.log(`Cost Basis: ${costBasis}`);


    if (!quoteResponse) {
      throw new Error('Failed to fetch quote response');
    }

    const { swapTransaction } = await (
      await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 7000000
        })
      })
    ).json();
    /**
     * 
     * cost basis = (in / out)/100  .00000806
     * half amount = outAmount/2    1.241.210
     * limit order = cost basis * 
     */

    if (!swapTransaction) {
      throw new Error('Failed to fetch swap transaction');
    }

    // Function to fetch a recent blockhash and set it in the transaction
    const updateTransactionBlockhash = async (transaction) => {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      console.log(`Fetched blockhash: ${blockhash}`);
      console.log(`Fetched height: ${lastValidBlockHeight}`);
      transaction.recentBlockhash = blockhash; // Set the recent blockhash
      transaction.feePayer = wallet.publicKey; // Set the fee payer
      transaction.sign([wallet.payer]);
    };

    try {
      const sellTransactionBuf = Buffer.from(swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(sellTransactionBuf);
      await updateTransactionBlockhash(transaction);

      const rawTransaction = transaction.serialize();
      const txid = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 5

      });
      let attempts = 0;
      while (attempts < maxRetries) {
        try {
          await connection.confirmTransaction((txid));
          console.log(`Sell Transaction successful: https://solscan.io/tx/${txid}`);
          return `Sell Transaction successful: https://solscan.io/tx/${txid}`;
        }
        catch(error){
          attempts++;
          console.error(`Sell Attempt ${attempts} failed: ${error.message}`);

        }

    } 
    return `Sell Transaction successful: https://solscan.io/tx/undefined`;    
  }
    catch (error) {
      if (error.message.includes('Blockhash not found')) {
        // Retry with a new blockhash
        console.log(error)
        console.warn('Retrying transaction with a new blockhash...');
        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        await updateTransactionBlockhash(transaction);

        const rawTransaction = transaction.serialize();
        const txid = await connection.sendRawTransaction(rawTransaction, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        maxRetries: 5
});
        console.log(`Transaction successful: https://solscan.io/tx/${txid}`);
        return `Transaction successful: https://solscan.io/tx/${txid}`;
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Error during swapTokens:', error);

    if (error instanceof SendTransactionError) {
      console.error('Transaction Logs:', error.logs);
    }

    return `Error during swapTokens: ${error.message}`;
  }
};
const main = async (iterations, coin, amt, slippage) => {
  try {
    const privateKeys = private
    console.log("Loaded Private Keys:", privateKeys);

    for (let i = 0; i < iterations; i++) {
      const privateKey = privateKeys[i % privateKeys.length];
      if (typeof privateKey !== 'string') {
        throw new Error(`Invalid private key format: ${privateKey}`);
      }
      const wallet = new Wallet(Keypair.fromSecretKey(bs58.decode(privateKey.trim())));
      return await swapTokens(wallet, coin, amt, slippage);
    }
  } catch (error) {
    console.error('Error in main function:', error);
    return `Error in main function: ${error.message}`;
  }
};
const sell = async (iterations, coin, amt, slippage) => {
  try {
    const privateKey = private

    console.log("Loaded Private Keys:", privateKey);
    const wallet = new Wallet(Keypair.fromSecretKey(bs58.decode(privateKey.trim())));
    return await sellTokens(wallet, coin, amt, slippage);
    
  } catch (error) {
    console.error('Error in main function:', error);
    return `Error in main function: ${error.message}`;
  }
};

async function TransferSol(address, _amount) {
  const updateTransactionBlockhash = async (transaction) => {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    console.log(`Fetched blockhash: ${blockhash}`);
    console.log(`Fetched height: ${lastValidBlockHeight}`);
    transaction.recentBlockhash = blockhash; // Set the recent blockhash
    transaction.feePayer = wallet.publicKey; // Set the fee payer
  };
  const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1400000,
  });
   
  const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 20000,
  });

  try {

    // Decode the private key string to Uint8Array
    const secretKey = bs58.decode(private);

    // Create a new keypair from the secret key
    const fromKeypair = solanaWeb3.Keypair.fromSecretKey(secretKey);

    // Define the recipient address
    const toPublicKey = new solanaWeb3.PublicKey(address);

    // Define the amount of SOL to send (in lamports, 1 SOL = 1,000,000,000 lamports)
    const amount = _amount * solanaWeb3.LAMPORTS_PER_SOL; // Sending 1 SOL for example

    // Create the transaction
    const transaction = new solanaWeb3.Transaction().add(modifyComputeUnits)
    .add(addPriorityFee).add(
        solanaWeb3.SystemProgram.transfer({
            fromPubkey: fromKeypair.publicKey,
            toPubkey: toPublicKey,
            lamports: amount,
        })
    );
    await updateTransactionBlockhash(transaction);

    // Sign and send the transaction
    const signature = await solanaWeb3.sendAndConfirmTransaction(
        connection,
        transaction,
        [fromKeypair]
    );
    console.log('Transaction successful with signature:', signature);
    return { success: true, signature: signature };
} catch (error) {
    console.error('Transaction failed:', error);
    return { success: false, error: error.message };
}
}

const iterations = 1;

app.use(express.json());

function apiKeyMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || apiKey !== VALID_API_KEY) {
    return res.status(401).send({ error: 'Unauthorized: Invalid or missing API key' });
  }

  next();
}

//app.use(apiKeyMiddleware);

app.get('/swap', async (req, res) => {
  const { coin, amt, slippage } = req.query;

  if (!coin || !amt || !slippage) {
    return res.status(400).send({ error: 'Missing required parameters' });
  }

  try {
    const response = await main( iterations, coin, amt, slippage);
    res.status(200).send({ message: `Swap Transaction successful: https://solscan.io/tx/${response.txid}`, amount: response.outAmount });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

app.get('/sell', async (req, res) => {
  const { coin, amt, slippage } = req.query;

  if (!coin || !amt || !slippage) {
    return res.status(400).send({ error: 'Missing required parameters' });
  }

  try {
    const response = await sell(iterations, coin, amt, slippage);
    res.status(200).send({ message: response });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});
app.post('/limit', async (req, res) => {
  const { inputMint, outputMint, inAmount, outAmount } = req.body;

  if (!inputMint || !outputMint || !inAmount || !outAmount) {
    return res.status(400).send({ error: 'Missing required parameters' });
  }

  try {
    const result = await createLimitOrder(inputMint, outputMint, inAmount, outAmount);
    res.status(200).send(result);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});
/*app.post('/transfer', apiKeyMiddleware, async (req, res) => {
  const { addresses, amount } = req.body;
  console.log(addresses);

  // Validate that the strings parameter is an array of strings
  if (!Array.isArray(addresses) || !addresses.every(item => typeof item === 'string')) {
      return res.status(400).json({ error: 'Invalid input: strings must be an array of strings' });
  }
  
  const results = [];
    for (const address of addresses) {
        const result = await TransferSol(address, amount);
        results.push({ address: address, result: result });
    }

    // Respond with the results
    res.json({ message: 'Transfers processed', results: results });
});*/

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
