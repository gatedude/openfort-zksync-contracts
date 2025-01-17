import { expect } from "chai"
import { encodeFunctionData, encodePacked, parseAbi } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { eip712WalletActions, toSinglesigSmartAccount } from "viem/zksync"
import { createWalletClient, createPublicClient, hashTypedData, http } from "viem"
import { getViemChainFromConfig, writeContract } from "../tasks/utils"
import { getGeneralPaymasterInput, serializeTransaction } from "viem/zksync"
import hre from "hardhat";

// Global test config
const owner = privateKeyToAccount(hre.network.config.accounts[0])
const chain = getViemChainFromConfig()
const openfortAccountAddress = hre.openfortAccountAddress

const publicClient = createPublicClient({
    chain,
    transport: http(),
})


// configure viem smart account
const accountWithOwner = toSinglesigSmartAccount({
    address: openfortAccountAddress,
    privateKey: hre.network.config.accounts[0],
})

const walletClient = createWalletClient({
    account: accountWithOwner,
    chain,
    transport: http(hre.network.config.url),
}).extend(eip712WalletActions())


describe("ERC20 interactions from Openfort Account", function () {
    const MOCK_ERC20_ON_SOPHON = "0x0a433954E786712354c5917D0870895c29EF7AE4";
    interface Tokens {
        mockERC20: `0x${string}`;
    }
    const tokens: Tokens = {
        mockERC20: MOCK_ERC20_ON_SOPHON
    };

    async function deployTokens() {
        // use already whitelisted mocks on Sophon
        // deploy token contracts only once for all tests on other chains
        if (chain.name != "Sophon" && tokens.mockERC20 == MOCK_ERC20_ON_SOPHON) {
            const artifact = await hre.deployer.loadArtifact("MockERC20");
            const contract = await hre.deployer.deploy(artifact, [], "create")
            tokens.mockERC20 = await contract.getAddress()
            console.log(`MockERC20 deployed to ${tokens.mockERC20}`)
        }
    }

    it("self-custody account flow: sign raw transaction", async function () {

        await deployTokens()

        const paymaster = {
            paymaster: process.env.SOPHON_TESTNET_PAYMASTER_ADDRESS as `0x${string}`,
            paymasterInput: getGeneralPaymasterInput({ innerInput: new Uint8Array() }),
        };

        const transactionRequest = await walletClient.prepareTransactionRequest({
            type: "eip712",
            account: accountWithOwner,
            from: accountWithOwner.address,
            chainId: chain.id,
            // MOCK ERC20 sophon contract
            to: tokens.mockERC20,
            // function mint(address sender = 0x9590Ed0C18190a310f4e93CAccc4CC17270bED40, unit256 amount = 42)
            data: "0x40c10f190000000000000000000000009590ed0c18190a310f4e93caccc4cc17270bed40000000000000000000000000000000000000000000000000000000000000002a",
            ...(chain.name === "Sophon" ? paymaster : {}),
        })

        const signableTransaction = {
            type: "eip712",
            from: accountWithOwner.address,
            chainId: chain.id,
            // preparedTransactionRequest

            nonce: transactionRequest.nonce,
            gas: transactionRequest.gas,
            maxFeePerGas: transactionRequest.maxFeePerGas,
            maxPriorityFeePerGas: transactionRequest.maxPriorityFeePerGas,

            to: tokens.mockERC20,
            data: "0x40c10f190000000000000000000000009590ed0c18190a310f4e93caccc4cc17270bed40000000000000000000000000000000000000000000000000000000000000002a",
            ...(chain.name === "Sophon" ? paymaster : {}),
        };

        // OPENFORT FLOW:
        // for self-custody accounts: Openfort returns a serialized signable hash from a transaction intent
        // User must sign it then call the `signature` endpoint to broadcast through `sendRawTranscatoin`

        const EIP712hash = hashTypedData(chain.custom.getEip712Domain(signableTransaction))
        const signature = await accountWithOwner.sign({ hash: EIP712hash })

        const signedTransaction = serializeTransaction({
            ...signableTransaction,
            customSignature: signature,
        });

        const hash = await publicClient.sendRawTransaction({
            serializedTransaction: signedTransaction,
        })

        console.log(`Send Raw Transaction Hash : ${hash}`)
    });


    it("sign with owner: balance should be updated", async function () {
        await deployTokens()

        const initialBalance = await publicClient.readContract({
            account: accountWithOwner,
            address: tokens.mockERC20,
            abi: parseAbi(["function balanceOf(address owner) external view returns (uint256)"]),
            functionName: "balanceOf",
            args: [openfortAccountAddress],
        });

        const amount = BigInt(42)
        // Mint tokens
        await writeContract(walletClient, {
            account: accountWithOwner,
            address: tokens.mockERC20,
            abi: parseAbi(["function mint(address sender, uint256 amount) external"]),
            functionName: "mint",
            args: [openfortAccountAddress, amount]
        })
        // Get final balance
        const finalBalance = await publicClient.readContract({
            account: accountWithOwner,
            address: tokens.mockERC20,
            abi: parseAbi(["function balanceOf(address owner) external view returns (uint256)"]),
            functionName: "balanceOf",
            args: [openfortAccountAddress],
        });

        // Assert that the final balance is the initial balance plus the minted amount
        expect(finalBalance - initialBalance).to.equal(amount);
    });

    it("register a valid session key and sign with it: balance should be updated", async function () {

        await deployTokens()
        const blockTimestamp = (await publicClient.getBlock()).timestamp

        // generate a new private key
        // to avoid Account contract reverts with "SessionKey already registered"

        const sessionKey = generatePrivateKey()
        const sessionKeyAccount = privateKeyToAccount(sessionKey)

        // setup openfort smart account with session key as signer
        const accountWithSessionKey = toSinglesigSmartAccount({
            address: openfortAccountAddress,
            privateKey: sessionKey
        })

        // register a new random sessionKey
        await writeContract(walletClient, {
            account: owner,
            address: openfortAccountAddress,
            abi: parseAbi(["function registerSessionKey(address, uint48, uint48, uint48, address[]) external"]),
            functionName: "registerSessionKey",
            // Session Key is valid for 24 hours
            args: [sessionKeyAccount.address, blockTimestamp, blockTimestamp + BigInt(24 * 60 * 60), 100, []],
        })

        // sign with the new sessionKey
        const amount = BigInt(42)


        // Make sure we sign with the session key
        const sessionKeyWalletClient = createWalletClient({
            account: sessionKeyAccount,
            chain,
            transport: http(hre.network.config.url),
        }).extend(eip712WalletActions())

        const hash = await writeContract(sessionKeyWalletClient, {
            account: accountWithSessionKey,
            address: tokens.mockERC20,
            abi: parseAbi(["function mint(address sender, uint256 amount) external"]),
            functionName: "mint",
            args: [openfortAccountAddress, amount],
        })
        console.log(`Sign With Session Key Tansaction Hash ${hash}`)
    })

    it("batch calls to mint should update balance accordingly", async function () {
        await deployTokens()
        const batchCallerAddress = "0x7219257B57d9546c1BC0649617d557Db09C92D23"; // salt 0x666
        // Each call data for batches
        const mintAbi = parseAbi(["function mint(address sender, uint256 amount) external"])

        const initialBalance = await publicClient.readContract({
            account: accountWithOwner,
            address: tokens.mockERC20,
            abi: parseAbi(["function balanceOf(address owner) external view returns (uint256)"]),
            functionName: "balanceOf",
            args: [openfortAccountAddress],
        });

        const calls = [
            {
                target: tokens.mockERC20,
                value: 0n,
                callData: encodeFunctionData({
                    abi: mintAbi,
                    functionName: 'mint',
                    args: [openfortAccountAddress, 10n]
                })
            },
            {
                target: tokens.mockERC20,
                value: 0n,
                callData: encodeFunctionData({
                    abi: mintAbi,
                    functionName: 'mint',
                    args: [openfortAccountAddress, 20n]
                })
            },
            {
                target: tokens.mockERC20,
                value: 0n,
                callData: encodeFunctionData({
                    abi: mintAbi,
                    functionName: 'mint',
                    args: [openfortAccountAddress, 30n]
                })
            },
            {
                target: tokens.mockERC20,
                value: 0n,
                callData: encodeFunctionData({
                    abi: mintAbi,
                    functionName: 'mint',
                    args: [openfortAccountAddress, 40n]
                })
            }
        ];

        const abi = [
          {
            inputs: [
              {
                components: [
                  {
                    internalType: "address",
                    name: "target",
                    type: "address"
                  },
                  {
                    internalType: "uint256",
                    name: "value",
                    type: "uint256"
                  },
                  {
                    internalType: "bytes",
                    name: "callData",
                    type: "bytes"
                  }
                ],
                internalType: "struct Call[]",
                name: "calls",
                type: "tuple[]"
              }
            ],
            name: "batchCall",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function"
          }
        ];


        const data = encodeFunctionData({
            abi: abi,
            functionName: "batchCall",
            args: [calls]
        })

        const paymaster = {
            paymaster: process.env.SOPHON_TESTNET_PAYMASTER_ADDRESS as `0x${string}`,
            paymasterInput: getGeneralPaymasterInput({ innerInput: new Uint8Array() }),
        };

        const transactionRequest = await walletClient.prepareTransactionRequest({
            type: "eip712",
            account: accountWithOwner,
            from: accountWithOwner.address,
            chainId: chain.id,
            to: batchCallerAddress,
            data: data,
            ...(chain.name === "Sophon" ? paymaster : {}),

        })

        const signableTransaction = {
            type: "eip712",
            from: accountWithOwner.address,
            chainId: chain.id,
            // preparedTransactionRequest

            nonce: transactionRequest.nonce,
            gas: transactionRequest.gas,
            maxFeePerGas: transactionRequest.maxFeePerGas,
            maxPriorityFeePerGas: transactionRequest.maxPriorityFeePerGas,
            to: batchCallerAddress,
            data: data,
            ...(chain.name === "Sophon" ? paymaster : {}),

        };

        const EIP712hash = hashTypedData(chain.custom.getEip712Domain(signableTransaction))
        const signature = await accountWithOwner.sign({ hash: EIP712hash })
        const signedTransaction = serializeTransaction({
            ...signableTransaction,
            customSignature: signature,
        });

        const thehash = await publicClient.sendRawTransaction({
            serializedTransaction: signedTransaction,
        })

        console.log("Batch Call Transaction Hash", thehash);

        const finalBalance = await publicClient.readContract({
            account: accountWithOwner,
            address: tokens.mockERC20,
            abi: parseAbi(["function balanceOf(address owner) external view returns (uint256)"]),
            functionName: "balanceOf",
            args: [openfortAccountAddress],
        });
        // Assert that the final balance is the initial balance plus the sum of all minted amounts
        expect(finalBalance - initialBalance).to.equal(10n + 20n + 30n + 40n);
    });
})