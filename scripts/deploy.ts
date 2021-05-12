import fs from 'fs-extra';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Wallet } from '@ethersproject/wallet';
import { ReserveAuctionV3Factory } from '../typechain/ReserveAuctionV3Factory';

const CHAIN_ID = 4;

async function start() {
  //   const args = require('minimist')(process.argv.slice(2));
  const args = { chainId: CHAIN_ID };

  if (!args.chainId) {
    throw new Error('--chainId chain ID is required');
  }
  const path = `${process.cwd()}/.env${
    args.chainId === 1 ? '.prod' : args.chainId === 4 ? '.dev' : '.local'
  }`;
  await require('dotenv').config({ path });
  const provider = new JsonRpcProvider(process.env.RPC_ENDPOINT);
  const wallet = new Wallet(`0x${process.env.PRIVATE_KEY}`, provider);
  const sharedAddressPath = `${process.cwd()}/addresses/${args.chainId}.json`;
  // @ts-ignore
  const addressBook = JSON.parse(await fs.readFileSync(sharedAddressPath));

  const ZORA_MEDIA_CONTRACT_ADDRESS = addressBook.media

  let wethAddress;
  let adminRecoveryAddress;

  if (CHAIN_ID === 4) {
    wethAddress = "0xc778417e063141139fce010982780140aa0cd5ab";
    adminRecoveryAddress = "0xCC65fA278B917042822538c44ba10AD646824026";
  } else if (CHAIN_ID === 1) {
    wethAddress = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
    adminRecoveryAddress = "";
  }

  // console.log('Deploying NFTFactory...');
  // const deployTx = await new NftFactoryFactory(wallet).deploy(
  //   ZORA_MEDIA_CONTRACT_ADDRESS
  // );
  // console.log('Deploy TX: ', deployTx.deployTransaction.hash);
  // await deployTx.deployed();
  // console.log('NFTFactory deployed at ', deployTx.address);
  // addressBook.NFTFactory = deployTx.address;

  console.log('Deploying ReserveAuctionV3...');
  const reserveAuctionDeployTx = await new ReserveAuctionV3Factory(wallet).deploy(
    ZORA_MEDIA_CONTRACT_ADDRESS,
    wethAddress,
    adminRecoveryAddress
  );
  console.log(`Deploy TX: ${reserveAuctionDeployTx.deployTransaction.hash}`);
  await reserveAuctionDeployTx.deployed();
  console.log(`ReserveAuction deployed at ${reserveAuctionDeployTx.address}`);

  addressBook.ReserveAuction = reserveAuctionDeployTx.address;

  await fs.writeFile(sharedAddressPath, JSON.stringify(addressBook, null, 2));
  console.log(`Contracts deployed and configured.`);

  process.exit();
}

start().catch((e: Error) => {
  console.error(e);
  process.exit(1);
});
