const { ethers } = require('ethers');
const axios = require('axios');
const dotenv = require('dotenv');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// 创建命令行交互接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// 加载环境变量
dotenv.config();

// 环境变量配置
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

// 定义多个网络的RPC节点
const NETWORK_RPC_URLS = {
  base: [
    process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    'https://base-mainnet.public.blastapi.io',
    'https://base.blockpi.network/v1/rpc/public',
    'https://1rpc.io/base'
  ]
};

// 当前选择的网络，默认为base
let CURRENT_NETWORK = process.env.NETWORK || 'base';
let RPC_URLS = NETWORK_RPC_URLS[CURRENT_NETWORK];

const API_BASE_URL = 'https://api.basedblocks.xyz';

// 合约地址 - 在不同网络上
const CONTRACT_ADDRESSES = {
  base: '0x64DC8E118ec25ba32B95daf010056D22b652637B'   // Base网络合约地址 - 请根据实际情况修改
};

// 获取当前网络的合约地址
let CONTRACT_ADDRESS = CONTRACT_ADDRESSES[CURRENT_NETWORK];

// 降低GAS价格和限制以确保交易成功
const GAS_PRICE = process.env.GAS_PRICE || '0.005'; // 降低Gwei
const GAS_LIMIT = process.env.GAS_LIMIT || '250000'; // 增加Gas限制
const CLAIM_INTERVAL = parseInt(process.env.CLAIM_INTERVAL || '60000'); // 检查间隔（毫秒）

// 合约ABI - 仅包含mine函数
const CONTRACT_ABI = [
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "hash",
        "type": "string"
      },
      {
        "internalType": "bytes",
        "name": "_signature",
        "type": "bytes"
      }
    ],
    "name": "mine",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  }
];

// 网络信息
const NETWORK_INFO = {
  blast: {
    name: 'Blast',
    chainId: 81457,
    nativeCurrency: 'ETH',
    blockExplorer: 'https://blastscan.io'
  },
  base: {
    name: 'Base',
    chainId: 8453,
    nativeCurrency: 'ETH',
    blockExplorer: 'https://basescan.org'
  }
};

// 用户确认函数
function askQuestion(question) {
  return new Promise(resolve => {
    rl.question(question, answer => {
      resolve(answer);
    });
  });
}

// 初始化
async function initialize() {
  if (!PRIVATE_KEY) {
    throw new Error('未设置私钥。请在.env文件中设置WALLET_PRIVATE_KEY');
  }
  
  console.log(`\n=== 网络检测 ===`);
  console.log(`当前配置的网络: ${CURRENT_NETWORK.toUpperCase()} (${NETWORK_INFO[CURRENT_NETWORK].name})`);
  console.log(`网络ID: ${NETWORK_INFO[CURRENT_NETWORK].chainId}`);
  
  // 从私钥中派生出公钥地址
  const tempWallet = new ethers.Wallet(PRIVATE_KEY);
  const derivedAddress = tempWallet.address;
  console.log(`\n从私钥派生的地址: ${derivedAddress}`);
  
  // 询问用户是否要切换网络
  const switchNetwork = await askQuestion(`\n当前网络为 ${CURRENT_NETWORK.toUpperCase()}，是否要切换网络? (y/n): `);
  if (switchNetwork.toLowerCase() === 'y') {
    const networks = Object.keys(NETWORK_INFO);
    console.log(`可用网络: ${networks.join(', ')}`);
    const newNetwork = await askQuestion('请输入要切换到的网络名称: ');
    
    if (NETWORK_INFO[newNetwork]) {
      CURRENT_NETWORK = newNetwork;
      RPC_URLS = NETWORK_RPC_URLS[CURRENT_NETWORK];
      CONTRACT_ADDRESS = CONTRACT_ADDRESSES[CURRENT_NETWORK];
      console.log(`已切换到 ${CURRENT_NETWORK.toUpperCase()} 网络`);
    } else {
      console.log(`无效的网络名称，将继续使用 ${CURRENT_NETWORK.toUpperCase()} 网络`);
    }
  }
  
  if (!CONTRACT_ADDRESS) {
    console.log(`\n⚠️ 警告: ${CURRENT_NETWORK.toUpperCase()} 网络上没有配置合约地址`);
    const customAddress = await askQuestion('请输入合约地址 (或留空取消): ');
    if (customAddress) {
      CONTRACT_ADDRESS = customAddress;
      console.log(`已设置合约地址: ${CONTRACT_ADDRESS}`);
    } else {
      throw new Error(`无法在 ${CURRENT_NETWORK.toUpperCase()} 网络上继续，缺少合约地址`);
    }
  }
  
  // 尝试所有RPC节点直到找到一个工作的
  let provider = null;
  let workingRpcUrl = null;
  
  console.log("\n正在连接RPC节点...");
  for (const rpcUrl of RPC_URLS) {
    try {
      const tempProvider = new ethers.providers.JsonRpcProvider(rpcUrl);
      
      // 测试连接 - 获取网络ID和区块
      const network = await tempProvider.getNetwork();
      const blockNumber = await tempProvider.getBlockNumber();
      
      // 确认这是正确的网络
      const expectedChainId = NETWORK_INFO[CURRENT_NETWORK].chainId;
      if (network.chainId !== expectedChainId) {
        continue;
      }
      
      provider = tempProvider;
      workingRpcUrl = rpcUrl;
      console.log(`✅ 已连接到RPC节点，区块高度: ${blockNumber}`);
      break;
    } catch (error) {
      // 简化错误输出
    }
  }
  
  if (!provider) {
    throw new Error(`无法连接到任何 ${CURRENT_NETWORK.toUpperCase()} 网络RPC节点`);
  }
  
  // 初始化钱包
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const address = wallet.address;
  console.log(`\n钱包地址: ${address}`);
  
  // 显示区块浏览器链接
  const explorerUrl = `${NETWORK_INFO[CURRENT_NETWORK].blockExplorer}/address/${address}`;
  console.log(`区块浏览器链接: ${explorerUrl}`);
  
  // 验证钱包余额是否可以获取
  try {
    const rawBalance = await provider.getBalance(address);
    if (rawBalance === undefined || rawBalance === null) {
      throw new Error('RPC返回了空的余额');
    }
    
    const balance = ethers.utils.formatEther(rawBalance);
    console.log(`✓ 钱包余额: ${balance} ${NETWORK_INFO[CURRENT_NETWORK].nativeCurrency}`);
    
    const continueExecution = await askQuestion('\n是否继续执行脚本? (y/n): ');
    if (continueExecution.toLowerCase() !== 'y') {
      console.log('已取消执行');
      process.exit(0);
    }
    
  } catch (error) {
    console.error(`❌ 无法获取钱包余额: ${error.message}`);
    console.log('尝试继续执行，但可能会失败...');
    
    const forceContinue = await askQuestion('仍然继续执行? (y/n): ');
    if (forceContinue.toLowerCase() !== 'y') {
      console.log('已取消执行');
      process.exit(0);
    }
  }
  
  try {
    // 验证合约地址格式是否正确
    const formattedContractAddress = ethers.utils.getAddress(CONTRACT_ADDRESS);
    console.log(`合约地址已验证: ${formattedContractAddress}`);
    
    // 初始化合约
    const contract = new ethers.Contract(formattedContractAddress, CONTRACT_ABI, wallet);
    
    return { wallet, address, contract, provider, rpcUrl: workingRpcUrl };
  } catch (error) {
    console.error('合约地址格式错误:', error.message);
    throw error;
  }
}

// 获取未领取区块
async function getUnclaimedBlocks(address) {
  try {
    console.log(`正在从 ${API_BASE_URL} 获取未领取区块...`);
    const response = await axios.get(`${API_BASE_URL}/address/${address}?claimed=false&limit=50`);
    return response.data.submissions;
  } catch (error) {
    console.error('获取未领取区块失败:', error.message);
    if (error.response) {
      console.error('服务器响应:', error.response.status, error.response.data);
    }
    return [];
  }
}

// 获取签名
async function getSignature(address, hash) {
  try {
    console.log(`正在获取签名 (hash: ${hash.substring(0, 10)}...)...`);
    const response = await axios.post(`${API_BASE_URL}/claim/${address}`, { hash });
    return response.data.signedMessage;
  } catch (error) {
    console.error(`获取签名失败 (hash: ${hash.substring(0, 10)}...):`, error.message);
    if (error.response) {
      console.error('服务器响应:', error.response.status, error.response.data);
    }
    return null;
  }
}

// 主循环函数
async function runMainLoop(wallet, address, contract, provider) {
  // 显示当前时间
  console.log(`\n===== ${new Date().toLocaleString()} =====`);
  
  // 详细检查余额但不输出详情
  const balanceCheck = await checkBalanceDetailed(wallet, provider, false);
  
  // 不管余额是否足够，都尝试处理未领取区块
  // 处理函数内部会根据余额决定处理多少个区块
  await processUnclaimedBlocks(address, contract, provider);
  
  // 显示处理完成信息
  console.log(`\n处理完成，下次检查将在 ${CLAIM_INTERVAL / 1000} 秒后进行`);
}

// 详细检查钱包余额
async function checkBalanceDetailed(wallet, provider, showDetails = true) {
  try {
    // 尝试多种方式获取余额
    let balance;
    let succeeded = false;
    
    // 方法1: 直接通过provider获取
    try {
      balance = await provider.getBalance(wallet.address);
      if (balance !== null && balance !== undefined) {
        succeeded = true;
      }
    } catch (e) {
      // 简化错误信息
    }
    
    // 方法2: 如果方法1失败，尝试直接通过jsonRpcFetch获取
    if (!succeeded) {
      try {
        const result = await provider.send("eth_getBalance", [wallet.address, "latest"]);
        if (result) {
          balance = ethers.BigNumber.from(result);
          succeeded = true;
        }
      } catch (e) {
        // 简化错误信息
      }
    }
    
    // 方法3: 如果前两种方法都失败，尝试通过新建provider
    if (!succeeded) {
      try {
        const fallbackRpcUrl = NETWORK_RPC_URLS[CURRENT_NETWORK][0];
        
        const newProvider = new ethers.providers.JsonRpcProvider(fallbackRpcUrl);
        const result = await newProvider.getBalance(wallet.address);
        if (result !== null && result !== undefined) {
          balance = result;
          succeeded = true;
        }
      } catch (e) {
        // 简化错误信息
      }
    }
    
    // 如果所有方法都失败
    if (!succeeded || !balance) {
      console.error("❌ 无法获取钱包余额");
      return { sufficient: false, error: "无法获取余额" };
    }
    
    const balanceInEth = ethers.utils.formatEther(balance);
    const currencyName = NETWORK_INFO[CURRENT_NETWORK].nativeCurrency;
    
    // 获取挖矿费用
    const mineFee = ethers.utils.parseEther('0.00003');
    
    // 获取当前gas价格
    const gasPrice = await provider.getGasPrice();
    // 使用85%的网络价格
    const adjustedGasPrice = gasPrice.mul(85).div(100);
    const gasPriceInGwei = ethers.utils.formatUnits(adjustedGasPrice, 'gwei');
    
    // 计算交易所需的预估总费用
    const gasLimit = ethers.BigNumber.from('250000');
    const gasCost = adjustedGasPrice.mul(gasLimit);
    const totalCost = gasCost.add(mineFee);
    const totalCostEth = ethers.utils.formatEther(totalCost);
    
    // 只在需要时显示详细信息
    if (showDetails) {
      console.log(`${currencyName}余额: ${balanceInEth} ${currencyName}`);
      console.log(`Gas价格: ${gasPriceInGwei} Gwei (网络当前价格的85%)`);
      console.log(`估计每笔交易总费用: ${totalCostEth} ${currencyName}`);
    }
    
    // 检查余额是否足够至少一笔交易
    if (balance.lt(totalCost)) {
      if (showDetails) {
        console.error(`❌ ${currencyName}余额不足！需要至少 ${totalCostEth} ${currencyName}`);
      }
      return { sufficient: false, balance, totalCost };
    } else {
      // 计算可以处理的交易数量
      const maxTxCount = Math.floor(balance.div(totalCost).toString());
      if (showDetails) {
        console.log(`✅ 余额充足，可以处理约 ${maxTxCount} 笔交易`);
      }
      return { sufficient: true, balance, totalCost, maxTxCount };
    }
  } catch (error) {
    console.error('检查余额时出错:', error.message);
    return { sufficient: false, error: error.message };
  }
}

// 领取奖励
async function claimReward(contract, hash, signature, provider) {
  try {
    // 获取mine函数需要的矿工费
    const mineFee = ethers.utils.parseEther('0.00003');
    
    // 获取当前网络的gas价格
    const currentGasPrice = await provider.getGasPrice();
    // 使用85%的当前gas价格以降低成本
    const gasPrice = currentGasPrice.mul(85).div(100);
    const gasPriceGwei = ethers.utils.formatUnits(gasPrice, 'gwei');
    
    // 设置Gas限制
    const gasLimit = ethers.BigNumber.from('250000');
    
    console.log(`准备领取区块奖励 (hash: ${hash.substring(0, 10)}...)`);
    
    const options = {
      value: mineFee,
      gasLimit: gasLimit,
      gasPrice: gasPrice
    };
    
    // 调用合约的mine函数
    console.log('正在发送交易...');
    const tx = await contract.mine(hash, signature, options);
    console.log(`交易已提交 (txHash: ${tx.hash})`);
    
    // 等待交易确认
    const receipt = await tx.wait();
    console.log(`✅ 交易已确认! 区块: ${receipt.blockNumber}, Gas使用: ${receipt.gasUsed.toString()}`);
    
    // 提供区块浏览器交易链接
    const currNetwork = CURRENT_NETWORK;
    const txUrl = `${NETWORK_INFO[currNetwork].blockExplorer}/tx/${tx.hash}`;
    console.log(`交易链接: ${txUrl}`);
    
    return true;
  } catch (error) {
    console.error(`领取奖励失败 (hash: ${hash.substring(0, 10)}...):`, error.message);
    
    // 打印关键错误信息
    if (error.reason) {
      console.error(`错误原因: ${error.reason}`);
    }
    
    return false;
  }
}

// 主函数
async function main() {
  try {
    console.log('================================================');
    console.log('⚡ 欢迎使用Based Blocks自动领取奖励脚本 ⚡');
    console.log('     ⚡ by 晚风(x.com/pl_wanfeng) ⚡');
    console.log('================================================');
    console.log('✅ 已将默认网络设置为Base网络');
    
    // 获取私钥
    let privateKey = PRIVATE_KEY;
    if (!privateKey) {
      console.error('❌ 请在.env文件中设置WALLET_PRIVATE_KEY环境变量');
      process.exit(1);
    }
    
    // 尝试从私钥创建钱包
    const wallet = new ethers.Wallet(privateKey);
    console.log(`\n钱包地址: ${wallet.address}`);
    
    // 询问用户是否是正确的钱包地址
    const addressConfirm = await askQuestion(`这是您期望的钱包地址吗？(y/n): `);
    if (addressConfirm.toLowerCase() !== 'y') {
      console.log('❌ 请检查您的私钥是否正确');
      process.exit(1);
    }
    
    // 显示当前网络信息
    console.log(`\n当前使用网络: ${NETWORK_INFO[CURRENT_NETWORK].name}`);
    console.log(`ChainID: ${NETWORK_INFO[CURRENT_NETWORK].chainId}`);
    
    // 尝试连接到选定网络的RPC节点
    let provider = null;
    let connectedRpcUrl = '';
    
    console.log("\n正在连接网络...");
    for (const rpcUrl of RPC_URLS) {
      try {
        provider = new ethers.providers.JsonRpcProvider(rpcUrl);
        
        // 验证网络连接
        const network = await provider.getNetwork();
        const expectedChainId = NETWORK_INFO[CURRENT_NETWORK].chainId;
        
        if (network.chainId === expectedChainId) {
          console.log(`✅ 已连接到${NETWORK_INFO[CURRENT_NETWORK].name}网络`);
          connectedRpcUrl = rpcUrl;
          break;
        } else {
          provider = null;
        }
      } catch (error) {
        // 简化错误输出
      }
    }
    
    if (!provider) {
      console.error(`❌ 无法连接到${NETWORK_INFO[CURRENT_NETWORK].name}网络，请检查网络连接`);
      process.exit(1);
    }
    
    // 创建钱包实例
    const connectedWallet = wallet.connect(provider);
    
    // 验证合约地址格式
    if (!CONTRACT_ADDRESS) {
      console.error(`❌ ${CURRENT_NETWORK}网络上没有配置合约地址`);
      const customAddress = await askQuestion('请输入合约地址: ');
      if (customAddress) {
        CONTRACT_ADDRESS = customAddress;
        console.log(`已设置合约地址: ${CONTRACT_ADDRESS}`);
      } else {
        console.error('未提供合约地址，无法继续');
        process.exit(1);
      }
    }
    
    // 格式化并验证合约地址
    try {
      CONTRACT_ADDRESS = ethers.utils.getAddress(CONTRACT_ADDRESS);
      console.log(`合约地址: ${CONTRACT_ADDRESS}`);
    } catch (error) {
      console.error(`❌ 合约地址格式无效: ${error.message}`);
      process.exit(1);
    }
    
    // 初始化合约
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, connectedWallet);
    
    // 获取并显示区块浏览器链接
    const explorerUrl = `${NETWORK_INFO[CURRENT_NETWORK].blockExplorer}/address/${wallet.address}`;
    console.log(`🔍 区块浏览器链接: ${explorerUrl}`);
    
    // 详细检查余额
    console.log('\n===== 正在检查钱包余额 =====');
    const balanceCheck = await checkBalanceDetailed(connectedWallet, provider);
    
    if (!balanceCheck.sufficient) {
      if (balanceCheck.error) {
        console.error(`❌ 无法获取余额: ${balanceCheck.error}`);
      } else if (balanceCheck.balance) {
        console.error(`❌ 余额不足，需要更多${NETWORK_INFO[CURRENT_NETWORK].nativeCurrency}`);
      }
      
      const forceContinue = await askQuestion('余额不足，是否仍然继续执行? (y/n): ');
      if (forceContinue.toLowerCase() !== 'y') {
        console.log('已取消执行');
        process.exit(0);
      }
    }
    
    console.log('\n===== 开始运行自动领取 =====');
    
    // 运行主循环
    await runMainLoop(connectedWallet, wallet.address, contract, provider);
    
    // 每隔一段时间运行一次
    console.log(`\n脚本将每 ${CLAIM_INTERVAL / 1000} 秒检查一次未领取奖励，项目方API请求参数存在问题，需要循环检查`);
    setInterval(async () => {
      await runMainLoop(connectedWallet, wallet.address, contract, provider);
    }, CLAIM_INTERVAL);
    
  } catch (error) {
    console.error('❌ 执行过程中出错:', error.message);
    process.exit(1);
  }
}

// 处理所有未领取区块
async function processUnclaimedBlocks(address, contract, provider) {
  try {
    console.log('\n正在检查未领取的区块...');
    
    // 获取钱包实例
    const wallet = contract.signer;
    
    // 再次检查余额确保有足够的资金 - 但不显示详情
    const balanceCheck = await checkBalanceDetailed(wallet, provider, false);
    if (!balanceCheck.sufficient) {
      console.log('余额不足，跳过处理');
      return;
    }
    
    // 获取未领取区块
    const unclaimedBlocks = await getUnclaimedBlocks(address);
    
    if (unclaimedBlocks.length === 0) {
      console.log('没有未领取的区块');
      return;
    }
    
    console.log(`发现 ${unclaimedBlocks.length} 个未领取区块`);
    
    // 计算可以处理的最大区块数
    const txCost = balanceCheck.totalCost;
    const availableFunds = balanceCheck.balance;
    const maxTxCount = Math.floor(availableFunds.div(txCost).toString());
    const currencyName = NETWORK_INFO[CURRENT_NETWORK].nativeCurrency;
    
    // 确定要处理的区块数量
    const blocksToProcess = Math.min(unclaimedBlocks.length, maxTxCount);
    
    if (blocksToProcess === 0) {
      console.error(`❌ 余额不足以处理任何区块，需要添加更多${currencyName}`);
      return;
    }
    
    console.log(`根据钱包余额计算，将处理 ${blocksToProcess} 个区块 (共发现 ${unclaimedBlocks.length} 个)`);
    
    // 逐个处理未领取区块
    for (let i = 0; i < blocksToProcess; i++) {
      const block = unclaimedBlocks[i];
      const { hashed: hash, id, timestamp } = block;
      
      console.log(`\n处理区块 ${i+1}/${blocksToProcess}: ID: ${id}`);
      
      // 获取签名
      const signature = await getSignature(address, hash);
      
      if (!signature) {
        console.log(`跳过区块 ${id}，无法获取签名`);
        continue;
      }
      
      // 再次检查余额确保有足够的资金用于本次交易 - 但不显示详情
      const currentBalanceCheck = await checkBalanceDetailed(wallet, provider, false);
      if (!currentBalanceCheck.sufficient) {
        console.log(`跳过剩余区块，余额不足`);
        return; // 终止处理剩余区块
      }
      
      // 领取奖励
      const success = await claimReward(contract, hash, signature, provider);
      
      if (success) {
        console.log(`🎉 成功领取区块 ${id} 的奖励!`);
      } else {
        console.log(`❌ 领取区块 ${id} 的奖励失败`);
      }
      
      // 等待一段时间再处理下一个区块，避免请求过于频繁
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // 如果还有未处理的区块但余额不足，提醒用户
    if (blocksToProcess < unclaimedBlocks.length) {
      const remaining = unclaimedBlocks.length - blocksToProcess;
      console.log(`\n⚠️ 还有 ${remaining} 个区块未处理，需要添加更多${currencyName}来处理剩余区块`);
    }
    
  } catch (error) {
    console.error('处理未领取区块时出错:', error.message);
  }
}

// 启动脚本
main().catch(console.error);